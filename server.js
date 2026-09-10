const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');

const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const COLLECTION_TIMEOUT_MS = 120_000;
const MAX_COLLECTION_OUTPUT = 8 * 1024 * 1024;
const MAX_TEST_OUTPUT = 4 * 1024 * 1024;
const MAX_SINGLE_EP_OUTPUT = 8 * 1024 * 1024;
const MAX_SINGLE_EP_CASE_OUTPUT = 2 * 1024 * 1024;
const SINGLE_EP_CASE_TIMEOUT_MS = 300_000;
const SINGLE_EP_TEST_DIR = process.env.SINGLEEP_TEST_DIR || '/home/lchen1/data/projs/llopt/codex/singleep/test';
const SINGLE_EP_RANKS = [1, 2, 4, 8, 16, 32];
const SINGLE_EP_TOKENS = {
  'low-latency': [1, 2, 4, 8, 16, 32, 64],
  intranode: [128, 256, 512, 1024, 2048, 4096, 8192],
  internode: [128, 256, 512, 1024, 2048, 4096, 8192]
};
const SINGLE_EP_TYPE_LABELS = {
  'low-latency': 'Low Latency',
  intranode: 'Intranode',
  internode: 'Internode'
};
const COLLECTION_TASKS = [
  ['META', '主机信息'], ['CPU', 'CPU / NUMA'], ['CPU_GOV', 'CPU 性能模式'],
  ['SYSTEM', '系统环境'], ['DMESG', '内核错误'], ['PCI_CTL', 'PCIe 控制'],
  ['PCI', 'PCIe 拓扑'], ['NET', '网卡设备'], ['IB', 'InfiniBand 状态'],
  ['IB_NET', 'RDMA 网口映射'], ['OFED', 'OFED 版本'], ['GIDS', 'GID 配置'],
  ['ROCE', 'RoCE 配置'], ['GPU_TOPO', 'GPU 拓扑'], ['GPU_HEALTH', 'GPU 状态'],
  ['MXLK', 'MetaxLink'], ['GPU_PCIE', 'GPU PCIe'], ['MACA', 'GPU 型号']
];
const COLLECTION_TASK_LABELS = new Map(COLLECTION_TASKS);
const TEST_LABELS = new Map([
  ['gpu-vector-add', 'GPU vectorAdd 测试'],
  ['gpu-bandwidth', 'GPU 带宽测试'],
  ['gpu-metaxlink', 'GPU MetaxLink alltoall'],
  ['gpu-pcie', 'GPU PCIe alltoall'],
  ['nic-bandwidth', '网卡带宽测试'],
  ['nic-latency', '网卡时延测试'],
  ['nic-alltoall', '网卡多流 alltoall'],
  ['host-ibrc', '单机 IBRC 测试'],
  ['host-ibgda', '单机 IBGDA 测试']
]);
let activePerformanceTest = null;
let activeClusterScan = false;

// This script only reads hardware state. Its tab-separated format is kept intentionally stable for parsing.
const INVENTORY_SCRIPT = String.raw`set +e
export LC_ALL=C
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
meta() { hostname; date -Is; }
cpu() { lscpu --json 2>/dev/null || lscpu; }
cpu_gov() { for p in /sys/devices/system/cpu/cpufreq/policy*/scaling_governor; do [ -r "$p" ] && printf '%s\t%s\n' "$(basename "$(dirname "$p")")" "$(cat "$p")"; done; }
gdr_info() {
  gdr_metax_info=$(modinfo metax 2>/dev/null)
  if [ -n "$gdr_metax_info" ]; then gdr_metax_present=yes; else gdr_metax_present=no; fi
  if [ -d /sys/module/metax ]; then gdr_metax_loaded=yes; else gdr_metax_loaded=no; fi
  gdr_kmd_version=$(printf '%s\n' "$gdr_metax_info" | awk '/^version:/{print $2; exit}')
  [ -n "$gdr_kmd_version" ] || gdr_kmd_version=unknown

  gdr_kmd_dmabuf=unknown
  if [ "$gdr_metax_present" = yes ]; then
    if printf '%s\n' "$gdr_metax_info" | grep -Eq '^import_ns:.*DMA_BUF'; then
      gdr_kmd_dmabuf=yes
    else
      gdr_kmd_module=$(printf '%s\n' "$gdr_metax_info" | awk '/^filename:/{print $2; exit}')
      if [ -r "$gdr_kmd_module" ] && command -v strings >/dev/null 2>&1; then
        if strings "$gdr_kmd_module" 2>/dev/null | grep -Eq '^dma_buf_(fd|get|put)$'; then gdr_kmd_dmabuf=yes; else gdr_kmd_dmabuf=no; fi
      fi
    fi
  fi

  gdr_peer_mem=unknown
  for gdr_properties in /sys/class/mxcd/mxcd/layout/properties /sys/class/metax/mxcd/layout/properties; do
    [ -r "$gdr_properties" ] || continue
    gdr_peer_value=$(awk '$1 == "peer_mem" { print $2; exit }' "$gdr_properties")
    if [ "$gdr_peer_value" = 0 ] || [ "$gdr_peer_value" = 1 ]; then gdr_peer_mem=$gdr_peer_value; break; fi
  done

  gdr_kernel_dmabuf=unknown
  gdr_rdma_dmabuf=unknown
  gdr_peer_symbols=unknown
  if [ -r /proc/kallsyms ]; then
    if grep -qw dma_buf_export /proc/kallsyms 2>/dev/null; then gdr_kernel_dmabuf=yes; else gdr_kernel_dmabuf=no; fi
    if grep -Eq '[[:space:]]ib_umem_dmabuf_get(_pinned)?([[:space:]]|$)' /proc/kallsyms 2>/dev/null; then gdr_rdma_dmabuf=yes; else gdr_rdma_dmabuf=no; fi
    if grep -qw ib_register_peer_memory_client /proc/kallsyms 2>/dev/null && grep -qw ib_unregister_peer_memory_client /proc/kallsyms 2>/dev/null; then gdr_peer_symbols=yes; else gdr_peer_symbols=no; fi
  fi

  gdr_ibverbs_dmabuf=unknown
  gdr_ibverbs_path=$(ldconfig -p 2>/dev/null | awk '/libibverbs\.so\.1/{print $NF; exit}')
  if [ -n "$gdr_ibverbs_path" ] && [ -r "$gdr_ibverbs_path" ]; then
    if command -v nm >/dev/null 2>&1; then
      if nm -D "$gdr_ibverbs_path" 2>/dev/null | grep -qw ibv_reg_dmabuf_mr; then gdr_ibverbs_dmabuf=yes; else gdr_ibverbs_dmabuf=no; fi
    elif command -v strings >/dev/null 2>&1; then
      if strings "$gdr_ibverbs_path" 2>/dev/null | grep -qw ibv_reg_dmabuf_mr; then gdr_ibverbs_dmabuf=yes; else gdr_ibverbs_dmabuf=no; fi
    fi
  fi

  gdr_perftest_dmabuf=unknown
  gdr_perftest_path=unknown
  for gdr_perftest in /opt/maca/tools/communication/rdma/perftest/tests/ib_write_bw /opt/maca/samples/mccl_tests/ib_perf/tests/ib_write_bw; do
    [ -x "$gdr_perftest" ] || continue
    gdr_perftest_path=$gdr_perftest
    if "$gdr_perftest" --help 2>&1 | grep -q -- '--use_maca_dmabuf'; then gdr_perftest_dmabuf=yes; else gdr_perftest_dmabuf=no; fi
    break
  done

  gdr_ib_reg_addr=$(cat /sys/module/metax/parameters/ib_reg_addr 2>/dev/null)
  gdr_ib_unreg_addr=$(cat /sys/module/metax/parameters/ib_unreg_addr 2>/dev/null)
  [ -n "$gdr_ib_reg_addr" ] || gdr_ib_reg_addr=unknown
  [ -n "$gdr_ib_unreg_addr" ] || gdr_ib_unreg_addr=unknown
  printf 'gdr_metax_present\t%s\n' "$gdr_metax_present"
  printf 'gdr_metax_loaded\t%s\n' "$gdr_metax_loaded"
  printf 'gdr_kmd_version\t%s\n' "$gdr_kmd_version"
  printf 'gdr_kmd_dmabuf\t%s\n' "$gdr_kmd_dmabuf"
  printf 'gdr_kernel_dmabuf\t%s\n' "$gdr_kernel_dmabuf"
  printf 'gdr_rdma_dmabuf\t%s\n' "$gdr_rdma_dmabuf"
  printf 'gdr_ibverbs_dmabuf\t%s\n' "$gdr_ibverbs_dmabuf"
  printf 'gdr_perftest_dmabuf\t%s\n' "$gdr_perftest_dmabuf"
  printf 'gdr_perftest_path\t%s\n' "$gdr_perftest_path"
  printf 'gdr_peer_mem\t%s\n' "$gdr_peer_mem"
  printf 'gdr_peer_symbols\t%s\n' "$gdr_peer_symbols"
  printf 'gdr_ib_reg_addr\t%s\n' "$gdr_ib_reg_addr"
  printf 'gdr_ib_unreg_addr\t%s\n' "$gdr_ib_unreg_addr"
}
system_info() {
  printf 'os\t%s\n' "$(grep '^PRETTY_NAME=' /etc/os-release 2>/dev/null | cut -d= -f2- | tr -d '\"' || echo unknown)"
  printf 'kernel\t%s\n' "$(uname -r 2>/dev/null || echo unknown)"
  printf 'arch\t%s\n' "$(uname -m 2>/dev/null || echo unknown)"
  printf 'product_name\t%s\n' "$(cat /sys/class/dmi/id/product_name 2>/dev/null || echo unknown)"
  printf 'bios_version\t%s\n' "$(cat /sys/class/dmi/id/bios_version 2>/dev/null || echo unknown)"
  printf 'memory_kb\t%s\n' "$(awk '/^MemTotal:/{print $2}' /proc/meminfo 2>/dev/null || echo 0)"
  printf 'user\t%s\n' "$(id -un 2>/dev/null || echo unknown)"
  printf 'groups\t%s\n' "$(id -nG 2>/dev/null || echo unknown)"
  printf 'nofile_soft\t%s\n' "$(ulimit -Sn 2>/dev/null || echo unknown)"
  printf 'nofile_hard\t%s\n' "$(ulimit -Hn 2>/dev/null || echo unknown)"
  printf 'cmdline\t%s\n' "$(cat /proc/cmdline 2>/dev/null || echo unknown)"
  printf 'iommu_count\t%s\n' "$(find /sys/class/iommu -mindepth 1 -maxdepth 1 -type l 2>/dev/null | wc -l)"
  printf 'iommu_modes\t%s\n' "$(find /sys/bus/pci/devices -path '*/iommu_group/type' -type f -exec cat {} + 2>/dev/null | sort -u | paste -sd, -)"
  printf 'firewalld\t%s\n' "$(systemctl is-active firewalld 2>/dev/null || echo unavailable)"
  printf 'ufw\t%s\n' "$(systemctl is-active ufw 2>/dev/null || echo unavailable)"
  printf 'video_group\t%s\n' "$(id -nG 2>/dev/null | tr ' ' '\n' | grep -qx video && echo yes || echo no)"
  printf 'vswitch_links\t%s\n' "$(if [ -e /opt/pci_switch_links ]; then echo present; else echo absent; fi)"
  gdr_info
}
dmesg_info() { dmesg --level=emerg,alert,crit,err 2>&1 | tail -n 100; }
pcie_ctl() {
  pci_ctl_raw="$tmp/PCI_CTL_RAW"
  lspci -Dvvv > "$pci_ctl_raw" 2>&1
  pci_ctl_status=$?
  if grep -q 'Capabilities: <access denied>' "$pci_ctl_raw"; then
    printf '__STATUS__\tpermission-denied\n'
  elif [ "$pci_ctl_status" -ne 0 ]; then
    printf '__STATUS__\tcommand-failed\n'
  fi
  awk '
    function flush() { if (b != "" && ctl != "") printf "%s\t%s\n", b, ctl }
    $1 ~ /^[[:xdigit:]]+:[[:xdigit:]]+:[[:xdigit:]]+\.[[:xdigit:]]$/ { flush(); b=$1; ctl=""; next }
    /ACSCtl:|ATSCtl:|RlxdOrd|MaxReadReq/ { line=$0; sub(/^[ \t]+/, "", line); ctl=ctl line ";" }
    END { flush() }
  ' "$pci_ctl_raw"
}
pci() {
  lspci -Dvvv 2>/dev/null | awk '
      function flush() { if (b != "") printf "%s\t%s\t%s\n", b, desc, link }
      $1 ~ /^[[:xdigit:]]+:[[:xdigit:]]+:[[:xdigit:]]+\.[[:xdigit:]]$/ { flush(); b=$1; line=$0; sub(/^[^ \t]+[ \t]+/, "", line); desc=line; link=""; next }
      /LnkCap:|LnkSta:/ { line=$0; sub(/^[ \t]+/, "", line); link=link line ";" }
      END { flush() }
    ' > "$tmp/PCI_SNAPSHOT"
  for d in /sys/bus/pci/devices/*; do
    [ -e "$d" ] || continue
    b=$(basename "$d"); c=""; v=""; dev=""; n=-1
    [ -r "$d/class" ] && IFS= read -r c < "$d/class"; [ -r "$d/vendor" ] && IFS= read -r v < "$d/vendor"; [ -r "$d/device" ] && IFS= read -r dev < "$d/device"; [ -r "$d/numa_node" ] && IFS= read -r n < "$d/numa_node"
    drv=$(basename "$(readlink "$d/driver" 2>/dev/null)" 2>/dev/null)
    chain=$(readlink -f "$d" 2>/dev/null | grep -oE '[0-9a-f]{4}:[0-9a-f]{2}:[0-9a-f]{2}\.[0-7]' | paste -sd, -)
    IFS=$'\t' read -r ignored desc link < <(awk -F '\t' -v key="$b" '$1 == key { print; exit }' "$tmp/PCI_SNAPSHOT")
    current_speed=""; current_width=""; max_speed=""; max_width=""
    [ -r "$d/current_link_speed" ] && IFS= read -r current_speed < "$d/current_link_speed"; [ -r "$d/current_link_width" ] && IFS= read -r current_width < "$d/current_link_width"
    [ -r "$d/max_link_speed" ] && IFS= read -r max_speed < "$d/max_link_speed"; [ -r "$d/max_link_width" ] && IFS= read -r max_width < "$d/max_link_width"
    if [ -n "$current_speed" ] && [ -n "$current_width" ]; then link="$link;LnkCap: Speed $max_speed, Width x$max_width;LnkSta: Speed $current_speed, Width x$current_width;"; fi
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$b" "$c" "$v" "$dev" "$n" "$drv" "$desc|$chain|$link"
  done
}
net() {
  default_devs=$(ip -o route show default 2>/dev/null | awk '{ for (i=1; i<=NF; i++) if ($i == "dev") print $(i+1) }' | sort -u | paste -sd' ' -)
  ssh_peer=$(printf '%s\n' "$SSH_CONNECTION" | awk '{ print $1 }')
  ssh_dev=""; [ -n "$ssh_peer" ] && ssh_dev=$(ip -o route get "$ssh_peer" 2>/dev/null | awk '{ for (i=1; i<=NF; i++) if ($i == "dev") { print $(i+1); exit } }')
  for n in /sys/class/net/*; do
    [ -e "$n" ] || continue; name=$(basename "$n"); b=$(basename "$(readlink -f "$n/device" 2>/dev/null)" 2>/dev/null)
    numa=$(cat "$n/device/numa_node" 2>/dev/null || echo -1); state=$(cat "$n/operstate" 2>/dev/null || echo unknown)
    driver_info=$(ethtool -i "$name" 2>/dev/null); driver=$(printf '%s\n' "$driver_info" | awk -F': ' '/^driver:/{print $2}'); version=$(printf '%s\n' "$driver_info" | awk -F': ' '/^version:/{print $2}'); firmware=$(printf '%s\n' "$driver_info" | awk -F': ' '/^firmware-version:/{print $2}')
    speed=$(ethtool "$name" 2>/dev/null | awk -F': ' '/^\tSpeed:|^Speed:/{print $2}'); addresses=$(ip -o -4 addr show dev "$name" scope global 2>/dev/null | awk '{print $4}' | paste -sd, -)
    master=$(basename "$(readlink -f "$n/master" 2>/dev/null)" 2>/dev/null); management=no
    if [[ " $default_devs $ssh_dev " == *" $name "* || ( -n "$master" && " $default_devs $ssh_dev " == *" $master "* ) ]]; then management=yes; fi
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$name" "$b" "$numa" "$state" "$driver" "$version" "$firmware|$speed|$management|$addresses"
  done
}
ib() { ibstat 2>&1; }
ib_net() { ibdev2netdev 2>&1; }
ofed() { ofed_info -s 2>&1; }
gids() { show_gids 2>&1; }
roce() { for n in /sys/class/net/*; do [ -d "$n/device" ] || continue; name=$(basename "$n"); pfc=$(mlnx_qos -i "$name" 2>/dev/null | grep -E 'Priority trust state|PFC configuration|enabled' | tr '\n' ';'); ecn=$(find "$n/ecn" -type f -maxdepth 5 -print -exec sh -c 'printf "%s=%s;" "$1" "$(cat "$1" 2>/dev/null)"' _ {} \; 2>/dev/null | head -c 2000); tos=$(find /sys/class/infiniband -path '*/tc/*/traffic_class' -type f -exec sh -c 'printf "%s=%s;" "$1" "$(cat "$1" 2>/dev/null)"' _ {} \; 2>/dev/null | head -c 1000); [ -n "$pfc$ecn$tos" ] && printf '%s\t%s\t%s\t%s\n' "$name" "$pfc" "$ecn" "$tos"; done; }
gpu_topo() { mx-smi topo -m 2>&1 || /opt/maca/bin/mx-smi topo -m 2>&1; }
gpu_health() { mx-smi -s 2>&1 || /opt/maca/bin/mx-smi -s 2>&1; }
mxlk() { mx-smi mxlk --show 2>&1 || /opt/maca/bin/mx-smi mxlk --show 2>&1; }
gpu_pcie() { mx-smi --show-pcie 2>&1 || /opt/maca/bin/mx-smi --show-pcie 2>&1; }
macainfo() { /opt/maca/bin/macainfo 2>&1 || command macainfo 2>&1; }
collect_task() { task_id="$1"; output="$2"; shift 2; "$@" > "$tmp/$output"; printf '__TOPO_PROGRESS__\t%s\n' "$task_id"; }
collect_task META META meta &
collect_task CPU CPU cpu &
collect_task CPU_GOV CPU_GOV cpu_gov &
collect_task SYSTEM SYSTEM system_info &
collect_task DMESG DMESG dmesg_info &
collect_task PCI_CTL PCI_CTL pcie_ctl &
collect_task PCI PCI pci &
collect_task NET NET net &
collect_task IB IB ib &
collect_task IB_NET IB_NET ib_net &
collect_task OFED OFED ofed &
collect_task GIDS GIDS gids &
collect_task ROCE ROCE roce &
collect_task GPU_TOPO GPU_TOPO gpu_topo &
collect_task GPU_HEALTH GPU_HEALTH gpu_health &
collect_task MXLK MXLK mxlk &
collect_task GPU_PCIE GPU_PCIE gpu_pcie &
collect_task MACA MACA macainfo &
wait
for section in META CPU CPU_GOV SYSTEM DMESG PCI_CTL PCI NET IB IB_NET OFED GIDS ROCE GPU_TOPO GPU_HEALTH MXLK GPU_PCIE MACA; do printf '__%s__\n' "$section"; cat "$tmp/$section" 2>/dev/null; done
true`;

function parseSections(output) {
  const names = ['META', 'CPU', 'CPU_GOV', 'SYSTEM', 'DMESG', 'PCI', 'PCI_CTL', 'NET', 'IB', 'IB_NET', 'OFED', 'GIDS', 'ROCE', 'GPU_TOPO', 'GPU_HEALTH', 'MXLK', 'GPU_PCIE', 'MACA'];
  const sections = Object.fromEntries(names.map((name) => [name, '']));
  let current = null;
  for (const line of output.split(/\r?\n/)) {
    const marker = /^__(META|CPU|CPU_GOV|SYSTEM|DMESG|PCI|PCI_CTL|NET|IB|IB_NET|OFED|GIDS|ROCE|GPU_TOPO|GPU_HEALTH|MXLK|GPU_PCIE|MACA)__$/.exec(line);
    if (marker) current = marker[1];
    else if (current) sections[current] += `${line}\n`;
  }
  return sections;
}

function typeFor(pci) {
  const [bdf, classCode, vendor, device, numa, driver, payload] = pci;
  const [description, chain = '', pcieLink = ''] = payload.split('|');
  const text = `${description} ${driver}`.toLowerCase();
  const pciId = `${vendor}:${device}`.toLowerCase().replaceAll('0x', '');
  // Server BMCs commonly expose a VGA-compatible PCI function.  It is a
  // management console, not a compute GPU, even though both use PCI class 03.
  const managementDisplay = pciId === '1bd4:0750'
    || /\baspeed\b|\bast(?:2[456]00)?\b|\bmgag200\b|matrox.{0,24}\bg200\b|\bserverengines\b|\bbmc.{0,16}(?:vga|display)/.test(text);
  let type = 'device';
  if (classCode.startsWith('0x0604')) type = 'switch';
  else if ((classCode.startsWith('0x03') || /vga|3d controller|display controller|metax/.test(text)) && !managementDisplay) type = 'gpu';
  else if (classCode.startsWith('0x02') || /ethernet|infiniband|network controller/.test(text)) type = 'nic';
  return { id: bdf, bdf, classCode, vendor, device, numa: Number(numa), driver, description, pcieLink, chain: chain.split(',').filter(Boolean), type };
}

function parseIbInfo(text, ibNetText) {
  const hcas = new Map();
  for (const block of text.split(/\n(?=CA ')/)) {
    const name = /^CA '([^']+)'/.exec(block)?.[1];
    if (!name) continue;
    const value = (pattern) => block.match(pattern)?.[1]?.trim() || '';
    hcas.set(name, { name, caType: value(/^\s*CA type:\s*(.+)$/m), firmware: value(/^\s*Firmware version:\s*(.+)$/m), state: value(/^\s*State:\s*(.+)$/m), rate: value(/^\s*Rate:\s*(.+)$/m), linkLayer: value(/^\s*Link layer:\s*(.+)$/m) });
  }
  const netToHca = new Map();
  for (const line of ibNetText.split(/\r?\n/)) {
    const match = /^(\S+) port \d+ ==> (\S+) \(([^)]+)\)/.exec(line.trim());
    if (match) netToHca.set(match[2], { ...hcas.get(match[1]), hca: match[1], netState: match[3] });
  }
  return netToHca;
}

function parsePcieLink(text) {
  const cap = /LnkCap:.*?Speed\s+([^,]+),\s+Width x(\d+)/.exec(text);
  const state = /LnkSta:.*?Speed\s+([^,]+),\s+Width x(\d+)/.exec(text);
  return { capSpeed: cap?.[1] || '', capWidth: cap?.[2] || '', speed: state?.[1] || '', width: state?.[2] || '' };
}

function parseKeyValueSection(text) {
  return new Map(text.split(/\r?\n/).filter(Boolean).map((line) => { const index = line.indexOf('\t'); return [index < 0 ? line : line.slice(0, index), index < 0 ? '' : line.slice(index + 1)]; }));
}

function parseCpuInfo(text) {
  const values = new Map();
  try {
    const parsed = JSON.parse(text);
    for (const entry of parsed.lscpu || []) values.set(String(entry.field || '').replace(/:\s*$/, ''), String(entry.data ?? '').trim());
  } catch {
    for (const line of text.split(/\r?\n/)) {
      const match = /^([^:]+):\s*(.+)$/.exec(line);
      if (match) values.set(match[1].trim(), match[2].trim());
    }
  }
  const number = (key) => { const value = Number(values.get(key)); return Number.isFinite(value) ? value : null; };
  return {
    architecture: values.get('Architecture') || '',
    model: values.get('Model name') || '',
    vendor: values.get('Vendor ID') || '',
    logicalCpus: number('CPU(s)'),
    sockets: number('Socket(s)'),
    coresPerSocket: number('Core(s) per socket'),
    threadsPerCore: number('Thread(s) per core'),
    numaNodes: number('NUMA node(s)')
  };
}

function parsePcieControls(text) {
  const result = new Map();
  let collectionStatus = '';
  for (const line of text.split(/\r?\n/).filter(Boolean)) {
    const [bdf, controls = ''] = line.split('\t');
    if (bdf === '__STATUS__') { collectionStatus = controls; continue; }
    if (!/^[0-9a-f]{4}:[0-9a-f]{2}:[0-9a-f]{2}\.[0-7]$/i.test(bdf)) continue;
    const ro = /\bRlxdOrd([+-])/i.exec(controls)?.[1] || '';
    const mrrs = /\bMaxReadReq\s+(\d+)\s+bytes/i.exec(controls)?.[1] || '';
    result.set(bdf.toLowerCase(), {
      raw:controls,
      acs:/ACSCtl:\s*([^;]+)/i.exec(controls)?.[1]?.trim() || '',
      ats:/ATSCtl:\s*([^;]+)/i.exec(controls)?.[1]?.trim() || '',
      ro:ro ? (ro === '+' ? 'Enabled (+)' : 'Disabled (-)') : '',
      mrrs:mrrs ? `${mrrs} bytes` : ''
    });
  }
  result.collectionStatus = collectionStatus;
  return result;
}

function parseRoce(text) {
  return new Map(text.split(/\r?\n/).filter(Boolean).map((line) => { const [name, pfc = '', ecn = '', tos = ''] = line.split('\t'); return [name, { pfc, ecn, tos }]; }));
}

function parseSpeedGbps(...values) {
  for (const raw of values) {
    const value = String(raw || '').trim();
    const match = /(\d+(?:\.\d+)?)\s*(?:G(?:b(?:it)?(?:\/s|ps|\/sec)?)?|M(?:b(?:it)?(?:\/s|ps|\/sec)?)?)?/i.exec(value);
    if (!match) continue;
    let speed = Number(match[1]);
    if (/\bM/i.test(value.slice(match.index + match[1].length))) speed /= 1000;
    if (Number.isFinite(speed) && speed > 0) return speed;
  }
  return 0;
}

function gpuCommandBlocks(text) {
  const headers = [...text.matchAll(/^GPU#(\d+)\s+(.+?)\s+((?:[0-9a-f]{4}:)?[0-9a-f]{2}:[0-9a-f]{2}\.[0-7])\s*$/gmi)];
  return headers.map((match, index) => ({
    index: Number(match[1]), model: match[2].trim(), bdf: match[3].toLowerCase(),
    body: text.slice(match.index, headers[index + 1]?.index ?? text.length)
  }));
}

function formatGpuMemory(kilobytes) {
  if (!Number.isFinite(kilobytes) || kilobytes <= 0) return '';
  const gib = kilobytes / 1024 / 1024;
  return `${Number.isInteger(gib) ? gib : gib.toFixed(1)} GiB`;
}

function parseGpuHealth(text) {
  const attached = /Attached GPUs\s*:\s*(\d+)/i.exec(text)?.[1];
  const value = (body, pattern) => body.match(pattern)?.[1]?.trim() || '';
  const devices = gpuCommandBlocks(text).map((block) => {
    const hbmTotalKb = Number(value(block.body, /^\s*(?:vis_vram|vram) total\s*:\s*(\d+)\s*KB/m)) || 0;
    const utilization = Number(value(block.body, /^\s*GPU\s*:\s*([\d.]+)\s*%/m));
    return {
      index: block.index, bdf: block.bdf, model: block.model,
      utilization: Number.isFinite(utilization) ? utilization : null,
      hbmTotalKb, hbmTotal: formatGpuMemory(hbmTotalKb),
      clock: value(block.body, /^\s*XCORE_CLK\s*:\s*([^\n]+)/m) || value(block.body, /^\s*SOC_CLK\s*:\s*([^\n]+)/m),
      vbios: value(block.body, /^\s*BIOS\s*:\s*([^\n]+)/m), maca: value(block.body, /^\s*MACA\s*:\s*([^\n]+)/m), kmd: value(block.body, /^\s*KMD\s*:\s*([^\n]+)/m)
    };
  });
  const versions = (name) => devices.map((device) => device[name]).filter(Boolean);
  const vbios = versions('vbios'); const maca = versions('maca'); const kmd = versions('kmd');
  const unavailable = /not found|unrecognized option|invalid option|error/i.test(text);
  return { attached: attached ? Number(attached) : null, vbios: [...new Set(vbios)], maca: [...new Set(maca)], kmd: [...new Set(kmd)], devices, unavailable };
}

function parseGpuPcie(text) {
  const value = (body, pattern) => body.match(pattern)?.[1]?.trim() || '';
  return gpuCommandBlocks(text).map((block) => ({
    index: block.index, bdf: block.bdf,
    speed: value(block.body, /^\s*Current Speed\s*:\s*([^\n]+)/m),
    width: value(block.body, /^\s*Current Width\s*:\s*x?(\d+)/m),
    capSpeed: value(block.body, /^\s*Max Speed\s*:\s*([^\n]+)/m),
    capWidth: value(block.body, /^\s*Max Width\s*:\s*x?(\d+)/m)
  }));
}

function parseMacainfo(text) {
  const models = [];
  let marketName = '';
  for (const line of text.split(/\r?\n/)) {
    const market = /^\s*Market Name:\s*(.+?)\s*$/.exec(line);
    if (market) { marketName = market[1].trim(); continue; }
    const deviceType = /^\s*Device Type:\s*(.+?)\s*$/.exec(line)?.[1]?.trim();
    if (!deviceType) continue;
    if (/\bGPU\b/i.test(deviceType) && marketName) models.push(marketName);
    marketName = '';
  }
  return { models: [...new Set(models)] };
}

function parseCpuGovernors(text) {
  const governors = new Map();
  for (const rawLine of text.split(/\r?\n/)) {
    const [rawPolicy = '', rawMode = ''] = rawLine.split('\t');
    const policy = rawPolicy.trim();
    const mode = rawMode.trim().toLowerCase();
    if (!/^policy\d+$/.test(policy) || !/^[a-z][a-z0-9_-]*$/.test(mode)) continue;
    governors.set(policy, { policy, mode });
  }
  return [...governors.values()].sort((left, right) => Number(left.policy.slice(6)) - Number(right.policy.slice(6)));
}

function evaluateGdrCompatibility(system, nodes, gpuCount) {
  const evidence = {
    metaxDriver: system.get('gdr_metax_loaded') || 'unknown',
    metaxKmdDmaBuf: system.get('gdr_kmd_dmabuf') || 'unknown',
    kernelDmaBuf: system.get('gdr_kernel_dmabuf') || 'unknown',
    rdmaDmaBuf: system.get('gdr_rdma_dmabuf') || 'unknown',
    ibverbsDmaBuf: system.get('gdr_ibverbs_dmabuf') || 'unknown',
    perftestDmaBuf: system.get('gdr_perftest_dmabuf') || 'unknown',
    peerMem: system.get('gdr_peer_mem') || 'unknown',
    peerSymbols: system.get('gdr_peer_symbols') || 'unknown',
    ibRegAddr: system.get('gdr_ib_reg_addr') || 'unknown',
    ibUnregAddr: system.get('gdr_ib_unreg_addr') || 'unknown'
  };
  const hasMetaxGpu = gpuCount > 0 && (evidence.metaxDriver === 'yes' || system.get('gdr_metax_present') === 'yes');
  const hasRdmaNic = nodes.some((node) => node.type === 'nic' && /^(RoCE|IB)$/.test(node.nicInfo?.transport || ''));
  const dmaBufRequirements = [
    ['MetaX KMD', evidence.metaxDriver],
    ['KMD DMA-BUF', evidence.metaxKmdDmaBuf],
    ['内核 DMA-BUF', evidence.kernelDmaBuf],
    ['RDMA DMA-BUF', evidence.rdmaDmaBuf],
    ['libibverbs DMA-BUF', evidence.ibverbsDmaBuf]
  ];
  const dmaBufReady = dmaBufRequirements.every(([, value]) => value === 'yes');
  const dmaBufBlocked = dmaBufRequirements.some(([, value]) => value === 'no');
  const peerMemReady = evidence.metaxDriver === 'yes' && evidence.peerMem === '1';
  const peerMemKnownUnavailable = evidence.peerMem === '0' || evidence.metaxDriver === 'no';
  const compatible = [];
  if (dmaBufReady) compatible.push('DMA-BUF');
  if (peerMemReady) compatible.push('PEERMEM');

  let status = 'unknown';
  let driverConfigured = null;
  let value;
  if (!hasMetaxGpu) {
    value = '未检测到已加载的 MetaX GPU 驱动';
  } else if (!hasRdmaNic) {
    value = '未检测到 IB/RoCE 网卡，无法核验 GDR';
  } else if (compatible.length) {
    status = 'pass';
    driverConfigured = true;
    value = `驱动正确 · 兼容 ${compatible.join('、')}`;
    if (dmaBufReady && !peerMemReady) value += evidence.peerMem === '0' ? ' · PEERMEM 未注册' : ' · PEERMEM 状态未知';
    if (peerMemReady && !dmaBufReady) value += ' · DMA-BUF 链路不完整';
  } else if (peerMemKnownUnavailable && dmaBufBlocked) {
    status = 'fail';
    driverConfigured = false;
    value = '驱动异常 · DMA-BUF / PEERMEM 均不可用';
  } else {
    value = '证据不完整，无法确认 DMA-BUF / PEERMEM';
  }

  const missingDmaBuf = dmaBufRequirements.filter(([, state]) => state !== 'yes').map(([label, state]) => `${label}=${state === 'no' ? '不支持' : '未知'}`);
  const detail = [
    `KMD ${system.get('gdr_kmd_version') || '未知'}`,
    `DMA-BUF ${dmaBufReady ? '就绪' : `未就绪（${missingDmaBuf.join('、') || '证据不足'}）`}`,
    `PEERMEM ${peerMemReady ? '已注册' : evidence.peerMem === '0' ? '未注册（peer_mem=0）' : '状态未知'}`,
    evidence.perftestDmaBuf === 'yes' ? 'ib_write_bw 支持 --use_maca_dmabuf' : evidence.perftestDmaBuf === 'no' ? 'ib_write_bw 未提供 --use_maca_dmabuf' : '未确认 ib_write_bw DMA-BUF 选项'
  ].join('；');
  const activation = dmaBufReady
    ? 'DMA-BUF 按任务启用：ib_perf 使用 --use_maca_dmabuf；MCCL 设置 MCCL_DMABUF_ENABLE=1 和 MACA_NUMA_MEMORY_POLICY=1。'
    : peerMemReady ? '当前 PEERMEM 已在驱动加载阶段注册，可直接用于 GDR MR 注册。' : '当前没有已确认可用的 GDR 显存注册机制。';
  return { status, value, detail, activation, applicable:hasMetaxGpu && hasRdmaNic, driverConfigured, compatible, dmaBuf:{ ready:dmaBufReady, missing:missingDmaBuf, perftestPath:system.get('gdr_perftest_path') || '', evidence }, peerMem:{ ready:peerMemReady, property:evidence.peerMem, symbols:evidence.peerSymbols, ibRegAddr:evidence.ibRegAddr, ibUnregAddr:evidence.ibUnregAddr } };
}

function issue(title, message, reference) { return { title, message, reference }; }

function applyCompliance(nodes, cpuGovernors, ofed, controls, system, roce, gpuHealth, gpuCount, mxlk, gids, dmesg, requestedProfile = 'auto', macainfo = { models: [] }) {
  const nonPerformanceGovernors = cpuGovernors.filter((governor) => governor.mode !== 'performance');
  const performanceGovernorCount = cpuGovernors.length - nonPerformanceGovernors.length;
  const cpuIssue = nonPerformanceGovernors.length
    ? issue('CPU 非 performance 模式', `${nonPerformanceGovernors.slice(0, 8).map((governor) => `${governor.policy}: ${governor.mode}`).join('、')}${nonPerformanceGovernors.length > 8 ? ` 等 ${nonPerformanceGovernors.length} 个策略` : ''}；应全部设为 performance。`, '指南 3.1.1、9.4') : null;
  const ofedVersion = /(\d{2}\.\d{2})/.exec(ofed)?.[1] || '';
  const ofedIssue = !ofedVersion ? issue('未检测到 OFED', 'ofed_info -s 没有返回版本，无法满足 RDMA 驱动要求。', '指南 4.10.1.1')
    : (Number(ofedVersion.slice(0, 2)) < 23 || Number(ofedVersion.slice(0, 2)) > 25 ? issue('OFED 版本不在已验证范围', `当前 ${ofedVersion}；已验证范围为 23.10 至 25.10。`, '指南 8.6.1') : null);
  const firmwareGroups = new Map();
  nodes.filter((node) => node.type === 'nic' && node.ib?.caType).forEach((node) => {
    const key = node.ib.caType;
    if (!firmwareGroups.has(key)) firmwareGroups.set(key, new Set());
    firmwareGroups.get(key).add(node.ib.firmware || node.net?.firmware || '未知');
  });
  const mismatchedFirmware = new Map([...firmwareGroups].filter(([, versions]) => versions.size > 1));
  const detectedVirtualized = /\b(kvm|qemu|xen|vmware|hypervisor)\b/i.test(`${system.get('cmdline') || ''} ${system.get('os') || ''}`) || system.get('iommu_modes')?.includes('identity');
  const isVirtualized = requestedProfile === 'virtualized' || (requestedProfile === 'auto' && detectedVirtualized);
  const acsValues = [...controls.values()].map((item) => item.acs).filter(Boolean);
  const acsEnabledCount = acsValues.filter((value) => /SrcValid\+/i.test(value)).length;
  // The deployment guide treats zero or one SrcValid+ entry as ACS disabled;
  // multiple enabled entries indicate that ACS is active system-wide.
  const acsOn = acsEnabledCount > 1;
  const iommuCount = Number(system.get('iommu_count') || 0);
  const iommuBad = isVirtualized
    ? (iommuCount === 0 || !/identity|dma|iommu=pt|iommu.passthrough=1/i.test(`${system.get('iommu_modes') || ''} ${system.get('cmdline') || ''}`))
    : (iommuCount > 0 && !/off|disable/i.test(system.get('cmdline') || ''));
  const gdr = evaluateGdrCompatibility(system, nodes, gpuCount);
  const gdrIssue = gdr.status === 'fail'
    ? issue('DMA-BUF / PEERMEM 均不可用', `${gdr.detail}。RDMA 网卡无法通过已确认的机制注册 GPU 显存。`, '指南 8.5.7、9.3.2.1') : null;
  const globalIssues = [];
  if (acsOn && !isVirtualized) globalIssues.push(issue('PCIe ACS 已开启', `检测到 ${acsEnabledCount} 个 ACSCtl SrcValid+；物理机/Docker 推荐关闭 ACS。`, '指南 3.2.4.1'));
  if (!acsOn && acsValues.length && isVirtualized) globalIssues.push(issue('虚拟化场景 ACS 未开启', '虚拟化场景要求主机侧开启 ACS；当前未发现多个 ACSCtl SrcValid+。', '指南 3.2.2.2'));
  if (iommuBad) globalIssues.push(issue('IOMMU 未关闭', `检测到 ${iommuCount} 个 IOMMU 设备；物理机/Docker 推荐关闭 IOMMU。`, '指南 3.2.3'));
  const groups = system.get('groups') || '';
  if (system.get('video_group') === 'no') globalIssues.push(issue('当前用户不在 video 组', 'GPU 访问可能失败，建议将运行账户加入 video 组。', '指南 9.1'));
  if (!system.get('nofile_soft') || Number(system.get('nofile_soft')) < 4096) globalIssues.push(issue('文件描述符上限偏低', `当前 soft nofile=${system.get('nofile_soft') || '未知'}。大规模 all-to-all 任务可能需要提高上限。`, '指南 9.6'));
  const osIssue = !system.get('os') || !system.get('kernel') ? issue('系统信息不完整', '未能完整读取 OS 或内核版本，无法进行环境一致性核验。', '指南 3.2.1') : null;
  if (osIssue) globalIssues.push(osIssue);
  if (gdrIssue) globalIssues.push(gdrIssue);
  if (gpuHealth.attached !== null && gpuHealth.attached !== gpuCount) globalIssues.push(issue('GPU 数量不一致', `mx-smi 报告 ${gpuHealth.attached} 张，PCIe 枚举到 ${gpuCount} 张。`, '一键巡检 10.1.3.2'));
  if (gpuHealth.vbios.length > 1) globalIssues.push(issue('GPU VBIOS 版本不一致', `检测到多个 VBIOS 版本：${gpuHealth.vbios.join(', ')}。`, '一键巡检 10.3.2.2'));
  if (gpuHealth.maca.length > 1) globalIssues.push(issue('GPU MACA 版本不一致', `检测到多个 MACA 版本：${gpuHealth.maca.join(', ')}。`, '一键巡检 10.1.3.2'));
  if (gpuHealth.kmd.length > 1) globalIssues.push(issue('GPU KMD 版本不一致', `检测到多个 KMD 版本：${gpuHealth.kmd.join(', ')}。`, '一键巡检 10.1.3.2'));
  nodes.forEach((node) => {
    node.issues = [];
    if (node.type === 'cpu' && cpuIssue) node.issues.push(cpuIssue);
    if (node.type === 'cpu') node.issues.push(...globalIssues.filter((entry) => /ACS|IOMMU|video|文件描述符|系统信息|GPU|DMA-BUF|PEERMEM/.test(entry.title)));
    if (node.type === 'gpu') node.issues.push(...globalIssues.filter((entry) => /GPU/.test(entry.title)));
    if (['gpu', 'nic', 'switch'].includes(node.type)) {
      const discoveredPcie = parsePcieLink(node.pcieLink || '');
      node.pcie = discoveredPcie.speed ? discoveredPcie : (node.gpuInfo?.pcie?.speed ? node.gpuInfo.pcie : discoveredPcie);
      if (node.pcie.speed && node.pcie.capSpeed && (node.pcie.speed !== node.pcie.capSpeed || node.pcie.width !== node.pcie.capWidth)) node.issues.push(issue('PCIe 链路降速', `当前 ${node.pcie.speed} x${node.pcie.width}，能力为 ${node.pcie.capSpeed} x${node.pcie.capWidth}。`, '指南 11.3、9.2.3'));
      const control = controls.get(node.bdf);
      if (control) {
        node.controls = control;
        const computeNic = node.type === 'nic' && !node.nicInfo?.isManagement && /^(RoCE|IB)$/.test(node.nicInfo?.transport || '');
        if (control.ats && /\bEnable-/i.test(control.ats) && isVirtualized) node.issues.push(issue('虚拟化场景 ATS 未开启', `当前 ATSCtl: ${control.ats}；虚拟机要求 GPU/NIC 上游 PCIe bridge 配置 ATS。`, '指南 3.2.2.2'));
        if (control.ro && /Disabled/i.test(control.ro) && computeNic) node.issues.push(issue('NIC Relaxed Ordering 未开启', `当前 RlxdOrd: ${control.ro}。`, '指南 4.12.1.2'));
        const mrrsBytes = Number.parseInt(control.mrrs, 10);
        if (Number.isFinite(mrrsBytes) && mrrsBytes > 256 && computeNic) node.issues.push(issue('NIC MRRS 大于 256', `当前 MaxReadReq: ${control.mrrs}；计算网卡应配置为 256 bytes。`, '指南 8.5.6'));
      }
    }
    if (node.type === 'nic' && /mlx|mellanox|nvidia/i.test(`${node.net?.driver} ${node.driver} ${node.description}`)) {
      if (ofedIssue) node.issues.push(ofedIssue);
      if (node.ib?.caType && mismatchedFirmware.has(node.ib.caType)) node.issues.push(issue('同型号网卡固件不一致', `${node.ib.caType} 检测到固件版本：${[...mismatchedFirmware.get(node.ib.caType)].join(', ')}。`, '指南 4.3.1'));
      const rate = Number((node.ib?.rate || '').match(/\d+/)?.[0] || 0);
      if ((rate >= 100 || /^MT412[3-9]|^MT413/.test(node.ib?.caType || '')) && node.ib?.state && node.ib.state !== 'Active') node.issues.push(issue('计算网卡链路非 Active', `当前状态为 ${node.ib.state || '未知'}。`, '指南 4.5'));
    }
    if (node.type === 'nic' && !node.nicInfo?.isManagement && /^(RoCE|IB)$/.test(node.nicInfo?.transport || '') && node.nicInfo.speedGbps > 0 && node.nicInfo.speedGbps < 100) node.issues.push(issue('计算网卡速率低于 100G', `当前 ${node.nicInfo.speedLabel}；计算网络要求至少 100 Gbps。`, '指南 2.3、4.5'));
    node.status = node.issues.length ? 'invalid' : 'ok';
  });
  const slowNics = nodes.filter((node) => node.type === 'nic' && node.issues.some((entry) => entry.title === '计算网卡速率低于 100G'));
  const atsValues = [...controls.values()].map((item) => item.ats).filter(Boolean);
  const roValues = [...controls.values()].map((item) => item.ro).filter(Boolean);
  const mrrsValues = [...new Set([...controls.values()].map((item) => Number.parseInt(item.mrrs, 10)).filter(Number.isFinite))].sort((left, right) => left - right);
  const atsEnabledCount = atsValues.filter((value) => /\bEnable\+/i.test(value)).length;
  const roEnabledCount = roValues.filter((value) => /Enabled/i.test(value)).length;
  const pcieControlParts = [];
  if (acsValues.length) pcieControlParts.push(`ACS ${acsOn ? '开启' : '关闭'}（SrcValid+ ${acsEnabledCount}）`);
  if (atsValues.length) pcieControlParts.push(`ATS 开启 ${atsEnabledCount}/${atsValues.length}`);
  if (roValues.length) pcieControlParts.push(`RO 开启 ${roEnabledCount}/${roValues.length}`);
  if (mrrsValues.length) pcieControlParts.push(`MRRS ${mrrsValues.join('/')} bytes`);
  if (controls.collectionStatus === 'permission-denied' && pcieControlParts.length) pcieControlParts.push('部分设备权限不足');
  const pcieControlIssues = globalIssues.some((entry) => /ACS/.test(entry.title)) || nodes.some((node) => node.issues.some((entry) => /ATS|Relaxed Ordering|MRRS/.test(entry.title)));
  const pcieControlValue = pcieControlParts.length
    ? pcieControlParts.join(' · ')
    : controls.collectionStatus === 'permission-denied'
      ? 'PCIe 配置空间权限不足，请使用 Root 采集'
      : controls.collectionStatus === 'command-failed'
        ? 'lspci 执行失败，请检查 pciutils'
        : '未发现 ACS/ATS/RO/MRRS 能力';
  const pcieControlStatus = pcieControlIssues ? 'fail' : pcieControlParts.length && controls.collectionStatus !== 'permission-denied' ? 'pass' : 'unknown';
  const checks = [
    { id:'pcie-controls', name:'PCIe ACS/ATS/RO/MRRS', value:pcieControlValue, status:pcieControlStatus, reference:'指南 3.2.2、3.2.4、4.12、8.5.6' },
    { id:'iommu', name:'IOMMU', value:iommuCount ? `${iommuCount} 个设备 · ${system.get('iommu_modes') || '模式未知'}` : '未启用', status:iommuBad ? 'fail' : 'pass', reference:'指南 3.2.3' },
    { id:'cpu', name:'CPU Performance 模式', value:cpuGovernors.length ? `${performanceGovernorCount}/${cpuGovernors.length} 个策略为 performance${nonPerformanceGovernors.length ? ` · ${nonPerformanceGovernors.length} 个异常` : ''}` : '未检测到', status:cpuIssue ? 'fail' : cpuGovernors.length ? 'pass' : 'unknown', reference:'指南 3.1.1' },
    { id:'gdr-memory', name:'DMA-BUF / PEERMEM', value:gdr.value, detail:`${gdr.detail}；${gdr.activation}`, status:gdr.status, reference:'指南 8.5.7、9.3.2.1' },
    { id:'ofed', name:'OFED', value:ofedVersion || '未检测到', status:ofedIssue ? 'fail' : 'pass', reference:'指南 8.6.1' },
    { id:'nic-speed', name:'计算网卡速率', value:slowNics.length ? `${slowNics.length} 个网口低于 100G` : '未发现低于 100G 的计算网口', status:slowNics.length ? 'fail' : 'pass', reference:'指南 2.3、4.5' },
    { id:'gpu-count', name:'GPU 数量', value:gpuHealth.attached === null ? `${gpuCount} 张 PCIe 设备` : `${gpuHealth.attached} / ${gpuCount}`, status:gpuHealth.attached !== null && gpuHealth.attached !== gpuCount ? 'fail' : gpuHealth.attached === null ? 'unknown' : 'pass', reference:'一键巡检 10.1.3.2' },
    { id:'video', name:'video 组', value:system.get('video_group') || '未检测到', status:system.get('video_group') === 'yes' ? 'pass' : 'fail', reference:'指南 9.1' },
    { id:'nofile', name:'文件描述符', value:`soft ${system.get('nofile_soft') || '?'} / hard ${system.get('nofile_hard') || '?'}`, status:Number(system.get('nofile_soft')) >= 4096 ? 'pass' : 'warn', reference:'指南 9.6' },
    { id:'gpu-health', name:'GPU / VBIOS', value:gpuHealth.attached === null ? '未解析 mx-smi 健康信息' : `${gpuHealth.attached} 张 · ${gpuHealth.vbios.length || 0} 个 VBIOS 版本`, status:gpuHealth.unavailable ? 'unknown' : (gpuHealth.vbios.length > 1 || gpuHealth.maca.length > 1 || gpuHealth.kmd.length > 1 || (gpuHealth.attached !== null && gpuHealth.attached !== gpuCount) ? 'fail' : 'pass'), reference:'一键巡检 10.3.2.2' },
    { id:'gpu-model', name:'GPU 型号', value:macainfo.models.length ? macainfo.models.join(', ') : '未检测到 macainfo 型号', status:macainfo.models.length ? 'pass' : 'unknown', reference:'macainfo' },
    { id:'metaxlink', name:'MetaxLink', value:/not found|unrecognized option|invalid option|error/i.test(mxlk) ? '未检测到或命令不支持' : '已采集链路状态', status:/not found|unrecognized option|invalid option|error/i.test(mxlk) ? 'unknown' : 'pass', reference:'指南 9.2.1' },
    { id:'roce', name:'RoCE PFC/ECN/DSCP', value:roce.size ? `已读取 ${roce.size} 个网口配置` : '未检测到或非 RoCE', status:roce.size ? 'unknown' : 'unknown', reference:'指南 4.9' },
    { id:'gid', name:'GID 配置', value:/not found|command not found|error/i.test(gids) ? '未检测到 show_gids' : '已采集，需跨节点比对', status:/not found|command not found|error/i.test(gids) ? 'unknown' : 'unknown', reference:'指南 4.8.4.4、4.9.1' },
    { id:'dmesg', name:'dmesg 错误', value:/Operation not permitted|Permission denied/i.test(dmesg) ? '权限不足' : (dmesg ? '发现错误输出，详见诊断' : '未发现 error 级输出'), status:/Operation not permitted|Permission denied/i.test(dmesg) ? 'unknown' : (dmesg ? 'warn' : 'pass'), reference:'一键巡检 10.3.3.5' },
    { id:'vswitch', name:'VSwitch', value:system.get('vswitch_links') === 'present' ? '发现拓扑文件' : '未发现拓扑文件', status:system.get('vswitch_links') === 'present' ? 'pass' : 'unknown', reference:'指南 3.1.2、9.7' }
  ];
  return { cpuGovernors, system: Object.fromEntries(system), globalIssues, profile: requestedProfile, detectedProfile: detectedVirtualized ? 'virtualized' : 'physical', checks, acs: { values: acsValues, enabled: acsOn, isVirtualized }, iommu: { count: iommuCount, modes: system.get('iommu_modes') || '', required: isVirtualized ? 'PT/identity' : 'disabled' }, gdr, ofed: { raw: ofed.trim(), version: ofedVersion || '未检测到', valid: !ofedIssue }, gpu: { reported: gpuHealth, models: macainfo.models, discovered: gpuCount }, issueCount: nodes.reduce((count, node) => count + node.issues.length, 0) };
}

function parseTopo(text) {
  const rows = text.split(/\r?\n/).filter((line) => /^GPU\d+\s+/.test(line.trim()));
  const links = [];
  for (const row of rows) {
    const cells = row.trim().split(/\s+/);
    const source = Number(cells[0].slice(3));
    cells.slice(1).forEach((value, index) => {
      if (index > source && value !== 'X' && !/^CPU|^NIC/.test(value)) links.push({ source, target: index, label: value });
    });
  }
  return links;
}

function parseInventory(output, source, requestedProfile = 'auto') {
  const sections = parseSections(output);
  const meta = sections.META.trim().split(/\r?\n/);
  const netByBdf = new Map(sections.NET.trim().split(/\r?\n/).filter(Boolean).map((line) => {
    const [name, bdf, numa, state, driver, version, payload] = line.split('\t');
    const [firmware = '', speed = '', management = 'no', addresses = ''] = (payload || '').split('|');
    return [bdf, { name, numa: Number(numa), state, driver, version, firmware, speed, isManagement: management === 'yes', addresses: addresses.split(',').filter(Boolean) }];
  }));
  const ibByNet = parseIbInfo(sections.IB, sections.IB_NET);
  const controls = parsePcieControls(sections.PCI_CTL);
  const system = parseKeyValueSection(sections.SYSTEM);
  const cpuInfo = parseCpuInfo(sections.CPU);
  const roce = parseRoce(sections.ROCE);
  const gpuHealth = parseGpuHealth(sections.GPU_HEALTH);
  const gpuPcie = parseGpuPcie(sections.GPU_PCIE);
  const macainfo = parseMacainfo(sections.MACA);
  const devices = sections.PCI.trim().split(/\r?\n/).filter(Boolean).map((line) => typeFor(line.split('\t')));
  const gpuHealthByBdf = new Map(gpuHealth.devices.map((item) => [item.bdf, item]));
  const gpuPcieByBdf = new Map(gpuPcie.map((item) => [item.bdf, item]));
  devices.forEach((item) => {
    if (netByBdf.has(item.bdf)) {
      item.net = netByBdf.get(item.bdf); item.ib = ibByNet.get(item.net.name); item.roce = roce.get(item.net.name);
      const transport = /infiniband/i.test(item.ib?.linkLayer || '') ? 'IB' : item.ib ? 'RoCE' : 'Ethernet';
      const speedGbps = parseSpeedGbps(item.net.speed, item.ib?.rate);
      item.nicInfo = { isManagement: item.net.isManagement, transport, speedGbps, speedLabel: speedGbps ? `${speedGbps} Gbps` : (item.net.speed || '速率未知'), isUp: item.net.state === 'up' || item.ib?.state === 'Active' };
    }
    if (item.type === 'gpu') {
      const health = gpuHealthByBdf.get(item.bdf) || {};
      const pcie = gpuPcieByBdf.get(item.bdf) || {};
      item.gpuInfo = { ...health, model: macainfo.models.length === 1 ? macainfo.models[0] : (health.model || macainfo.models[0] || ''), pcie };
    }
    item.controls = controls.get(item.bdf);
  });
  const cpuRows = [...sections.CPU.matchAll(/NUMA node\(s\):\s*(\d+)/g)];
  const numaCount = cpuRows.length ? Number(cpuRows[0][1]) : Math.max(1, ...devices.map((item) => item.numa + 1).filter(Number.isFinite));
  const endpoints = devices.filter((item) => ['gpu', 'nic'].includes(item.type));
  // A multi-port switch exposes every port as a PCI bridge. Collapse those ports to the
  // first PEX/PLX switch bridge in an endpoint's sysfs path so the graph stays readable.
  const bridges = new Map(devices.filter((item) => item.type === 'switch').map((item) => [item.bdf, item]));
  const isSwitchChip = (item) => item && /\b(pex|plx)\b|pcie.{0,20}switch|switch.{0,20}pcie|0x10b5/i.test(`${item.description} ${item.vendor}`);
  const selectedSwitches = new Map();
  endpoints.forEach((item) => {
    const switchBdf = item.chain.find((bdf) => isSwitchChip(bridges.get(bdf)));
    if (switchBdf) selectedSwitches.set(switchBdf, bridges.get(switchBdf));
  });
  const relevant = [...endpoints, ...selectedSwitches.values()];
  const nodes = Array.from({ length: Math.max(1, numaCount) }, (_, index) => ({ id: `cpu-${index}`, type: 'cpu', label: `CPU / NUMA ${index}`, numa: index }));
  const typeIndexes = { gpu: 0, nic: 0, switch: 0 };
  relevant.forEach((item) => {
    const index = typeIndexes[item.type]++;
    item.id = `${item.type}-${item.bdf}`;
    item.label = item.type === 'gpu' ? `GPU ${item.gpuInfo?.index ?? index}` : item.type === 'nic' ? (item.net?.name || `NIC ${index}`) : `PCIe Switch ${index + 1}`;
  });
  const bdfToNode = new Map(relevant.map((item) => [item.bdf, item]));
  const edges = [];
  const seen = new Set();
  for (const item of relevant.filter((candidate) => candidate.type !== 'switch')) {
    const ancestor = item.chain.find((bdf) => bdfToNode.get(bdf)?.type === 'switch');
    const target = ancestor ? bdfToNode.get(ancestor).id : `cpu-${Math.max(0, item.numa)}`;
    const key = `${item.id}-${target}`;
    if (!seen.has(key)) { edges.push({ source: item.id, target, kind: 'pcie' }); seen.add(key); }
  }
  for (const bridge of relevant.filter((item) => item.type === 'switch')) edges.push({ source: bridge.id, target: `cpu-${Math.max(0, bridge.numa)}`, kind: 'upstream' });
  const graphNodes = [...nodes, ...relevant];
  const cpuGovernors = parseCpuGovernors(sections.CPU_GOV);
  const compliance = applyCompliance(graphNodes, cpuGovernors, sections.OFED, controls, system, roce, gpuHealth, relevant.filter((item) => item.type === 'gpu').length, sections.MXLK, sections.GIDS, sections.DMESG, requestedProfile, macainfo);
  graphNodes.filter((node) => node.type === 'cpu').forEach((node) => { node.attachedSwitchCount = edges.filter((edge) => edge.source.startsWith('switch-') && edge.target === node.id).length; });
  graphNodes.filter((node) => node.type === 'switch').forEach((node) => {
    const children = edges.filter((edge) => edge.target === node.id).map((edge) => graphNodes.find((item) => item.id === edge.source)).filter(Boolean);
    const upstreamEdges = edges.filter((edge) => edge.source === node.id);
    const ownIndex = node.chain.indexOf(node.bdf); const upstreamBdfs = ownIndex > 0 ? [node.chain[ownIndex - 1]] : [];
    node.switchInfo = { gpuCount: children.filter((item) => item.type === 'gpu').length, nicCount: children.filter((item) => item.type === 'nic').length, upstreamCount: Math.max(upstreamEdges.length, upstreamBdfs.length), upstreamBdfs };
  });
  return {
    source,
    profile: requestedProfile,
    hostname: meta[0] || source,
    collectedAt: meta[1] || new Date().toISOString(),
    machine: {
      ...cpuInfo, os: system.get('os') || '', kernel: system.get('kernel') || '', systemArch: system.get('arch') || '',
      productName: system.get('product_name') || '', biosVersion: system.get('bios_version') || '', memoryKb: Number(system.get('memory_kb')) || null
    },
    nodes: graphNodes, edges,
    gpuLinks: parseTopo(sections.GPU_TOPO),
    summary: { cpus: nodes.length, gpus: relevant.filter((item) => item.type === 'gpu').length, nics: relevant.filter((item) => item.type === 'nic').length, switches: relevant.filter((item) => item.type === 'switch').length },
    compliance,
    diagnostics: { ibstat: sections.IB.trim(), gpuTopo: sections.GPU_TOPO.trim(), macainfo: sections.MACA.trim(), ofed: sections.OFED.trim(), system: sections.SYSTEM.trim(), dmesg: sections.DMESG.trim(), pcieControls: sections.PCI_CTL.trim(), gids: sections.GIDS.trim(), roce: sections.ROCE.trim(), gpuHealth: sections.GPU_HEALTH.trim(), mxlk: sections.MXLK.trim(), gpuPcie: sections.GPU_PCIE.trim() }
  };
}

function runInventory(command, args, { onProgress, input = INVENTORY_SCRIPT, fdPassword = '' } = {}) {
  return new Promise((resolve, reject) => {
    const hasPasswordFd = Boolean(fdPassword);
    const child = spawn(command, args, { stdio: hasPasswordFd ? ['pipe', 'pipe', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'] });
    const stdoutChunks = [];
    const stderrChunks = [];
    const decoder = new StringDecoder('utf8');
    const completed = new Set();
    let progressBuffer = '';
    let outputSize = 0;
    let terminalError = null;
    let forceKillTimer = null;

    const stop = (error) => {
      if (terminalError) return;
      terminalError = error;
      child.kill('SIGTERM');
      forceKillTimer = setTimeout(() => child.kill('SIGKILL'), 1_000);
      forceKillTimer.unref?.();
    };
    const inspectProgress = (text) => {
      progressBuffer += text;
      let newline;
      while ((newline = progressBuffer.indexOf('\n')) >= 0) {
        const line = progressBuffer.slice(0, newline).replace(/\r$/, '');
        progressBuffer = progressBuffer.slice(newline + 1);
        const taskId = /^__TOPO_PROGRESS__\t([A-Z_]+)$/.exec(line)?.[1];
        if (!taskId || !COLLECTION_TASK_LABELS.has(taskId) || completed.has(taskId)) continue;
        completed.add(taskId);
        try {
          onProgress?.({ task: taskId, label: COLLECTION_TASK_LABELS.get(taskId), completed: completed.size, total: COLLECTION_TASKS.length });
        } catch {
          // A disconnected browser must not interrupt the read-only collection itself.
        }
      }
    };

    child.stdout.on('data', (chunk) => {
      outputSize += chunk.length;
      if (outputSize > MAX_COLLECTION_OUTPUT) return stop(new Error('采集结果超过 8 MiB 限制。'));
      stdoutChunks.push(chunk);
      inspectProgress(decoder.write(chunk));
    });
    child.stderr.on('data', (chunk) => {
      outputSize += chunk.length;
      if (outputSize > MAX_COLLECTION_OUTPUT) return stop(new Error('采集结果超过 8 MiB 限制。'));
      stderrChunks.push(chunk);
    });
    child.on('error', (error) => stop(error));
    child.stdin.on('error', () => {});
    if (hasPasswordFd) {
      child.stdio[3].on('error', () => {});
      child.stdio[3].end(`${fdPassword}\n`);
    }

    const timeout = setTimeout(() => stop(new Error(`采集超过 ${COLLECTION_TIMEOUT_MS / 1000} 秒，已停止。`)), COLLECTION_TIMEOUT_MS);
    child.on('close', (code, signal) => {
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      inspectProgress(decoder.end());
      const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
      if (terminalError) { terminalError.stderr = stderr; return reject(terminalError); }
      if (code !== 0) {
        const error = new Error(`采集命令退出，状态码 ${code ?? signal ?? '未知'}。`);
        error.code = code;
        error.stderr = stderr;
        return reject(error);
      }
      const stdout = Buffer.concat(stdoutChunks).toString('utf8').replace(/^__TOPO_PROGRESS__\t[A-Z_]+\r?\n/gm, '');
      resolve(stdout);
    });
    child.stdin.end(input);
  });
}

async function collect(target, onProgress) {
  if (!target || typeof target !== 'object' || Array.isArray(target)) throw new Error('采集请求格式无效。');
  const profile = ['auto', 'physical', 'virtualized'].includes(target.profile) ? target.profile : 'auto';
  const useRoot = target.useRoot === true;
  const password = typeof target.password === 'string' ? target.password : '';
  if (password.length > 512) throw new Error('密码长度不能超过 512 个字符。');
  if (/[\r\n\0]/.test(password)) throw new Error('密码不能包含换行符或空字符。');
  let command;
  let args;
  let input = INVENTORY_SCRIPT;
  let fdPassword = '';
  if (target.kind === 'remote') {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9.:-]*$/.test(target.host || '')) throw new Error('远程地址格式无效。');
    if (target.user && !/^[a-z_][a-z0-9_-]*$/i.test(target.user)) throw new Error('SSH 用户名格式无效。');
    const port = Number(target.port) || 22;
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('SSH 端口必须在 1 到 65535 之间。');
    const sshArgs = [
      '-o', `BatchMode=${password ? 'no' : 'yes'}`,
      '-o', 'NumberOfPasswordPrompts=1',
      '-o', 'StrictHostKeyChecking=accept-new',
      '-o', 'ConnectTimeout=8',
      '-p', String(port)
    ];
    if (target.identityFile) sshArgs.push('-i', target.identityFile);
    let remoteCommand = 'bash -s';
    if (useRoot) {
      if (password) {
        const encodedScript = Buffer.from(INVENTORY_SCRIPT, 'utf8').toString('base64');
        const executeScript = `printf %s '${encodedScript}' | base64 -d | bash -s`;
        remoteCommand = `if [ "$(id -u)" -eq 0 ]; then ${executeScript}; else sudo -S -p '' bash -c "${executeScript}"; fi`;
        input = `${password}\n`;
      } else remoteCommand = 'if [ "$(id -u)" -eq 0 ]; then bash -s; else sudo -n bash -s; fi';
    }
    sshArgs.push(`${target.user ? `${target.user}@` : ''}${target.host}`, remoteCommand);
    if (password) { command = 'sshpass'; args = ['-d', '3', 'ssh', ...sshArgs]; fdPassword = password; }
    else { command = 'ssh'; args = sshArgs; }
  } else {
    const alreadyRoot = typeof process.getuid === 'function' && process.getuid() === 0;
    if (useRoot && !alreadyRoot && password) {
      command = 'sudo'; args = ['-S', '-p', '', 'bash', '-c', INVENTORY_SCRIPT]; input = `${password}\n`;
    } else {
      command = useRoot && !alreadyRoot ? 'sudo' : 'bash';
      args = useRoot && !alreadyRoot ? ['-n', 'bash', '-s'] : ['-s'];
    }
  }
  let stdout;
  try { stdout = await runInventory(command, args, { onProgress, input, fdPassword }); }
  catch (error) {
    if (command === 'sshpass' && error.code === 'ENOENT') throw new Error('密码 SSH 登录需要在运行本服务的机器上安装 sshpass。');
    if (command === 'sshpass' && error.code === 5) throw new Error('SSH 密码认证失败，请检查用户名和密码。');
    if (command === 'sshpass' && error.code === 6) throw new Error('SSH 新主机密钥自动记录失败，请检查服务账号的 ~/.ssh/known_hosts 写权限。');
    if (command === 'sshpass' && error.code === 7) throw new Error('SSH 主机密钥已变更，请检查 known_hosts。');
    throw error;
  }
  return parseInventory(stdout, target.kind === 'remote' ? target.host : '本机', profile);
}

function clusterRequest(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('集群采集请求格式无效。');
  const size = Number(payload.size);
  if (![2, 4, 8].includes(size)) throw new Error('集群规模只支持 2、4 或 8 台机器。');
  const hosts = (Array.isArray(payload.hosts) ? payload.hosts : String(payload.hosts || '').split(/[,\uff0c\s]+/))
    .map((host) => String(host).trim()).filter(Boolean);
  if (hosts.length !== size) throw new Error(`当前选择 ${size} 台机器，需要填写 ${size} 个 IP 地址。`);
  if (new Set(hosts.map((host) => host.toLowerCase())).size !== hosts.length) throw new Error('IP 地址不能重复。');
  for (const host of hosts) if (!/^[a-zA-Z0-9][a-zA-Z0-9.:-]*$/.test(host)) throw new Error(`远程地址格式无效：${host}`);
  const user = String(payload.user || '');
  if (user && !/^[a-z_][a-z0-9_-]*$/i.test(user)) throw new Error('SSH 用户名格式无效。');
  const port = Number(payload.port) || 22;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('SSH 端口必须在 1 到 65535 之间。');
  const password = typeof payload.password === 'string' ? payload.password : '';
  if (password.length > 512 || /[\r\n\0]/.test(password)) throw new Error('密码格式无效。');
  const identityFile = typeof payload.identityFile === 'string' ? payload.identityFile : '';
  if (identityFile.length > 1024 || /[\r\n\0]/.test(identityFile)) throw new Error('私钥路径格式无效。');
  const profile = ['auto', 'physical', 'virtualized'].includes(payload.profile) ? payload.profile : 'auto';
  return { size, hosts, user, port, password, identityFile, profile, useRoot: payload.useRoot === true };
}

function listMetric(entries, emptyText = '未检测到') {
  return entries.length ? entries.join(' · ') : emptyText;
}

function topologyMetric(data) {
  const nodes = data.nodes || [];
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const children = new Map();
  for (const edge of data.edges || []) {
    if (!children.has(edge.target)) children.set(edge.target, []);
    children.get(edge.target).push(nodeById.get(edge.source));
  }
  const cpuLayouts = nodes.filter((node) => node.type === 'cpu').map((cpu) => {
    const direct = (children.get(cpu.id) || []).filter(Boolean);
    const switches = direct.filter((node) => node.type === 'switch').map((node) => {
      const endpoints = (children.get(node.id) || []).filter(Boolean);
      return `S(g${endpoints.filter((item) => item.type === 'gpu').length},n${endpoints.filter((item) => item.type === 'nic').length},u${node.switchInfo?.upstreamCount || 0})`;
    }).sort();
    return `CPU(g${direct.filter((node) => node.type === 'gpu').length},n${direct.filter((node) => node.type === 'nic').length},${switches.join(',')})`;
  }).sort();
  const linkCounts = new Map();
  for (const link of data.gpuLinks || []) linkCounts.set(link.label, (linkCounts.get(link.label) || 0) + 1);
  const links = [...linkCounts].sort(([left], [right]) => left.localeCompare(right)).map(([label, count]) => `${label}:${count}`);
  const signature = JSON.stringify({ cpuLayouts, links, summary:data.summary || {} });
  const endpointCount = (data.summary?.gpus || 0) + (data.summary?.nics || 0) + (data.summary?.switches || 0);
  return {
    available: nodes.length > 0 && Boolean(data.machine?.numaNodes || endpointCount),
    signature,
    value: `${data.summary?.cpus || 0} NUMA · ${data.summary?.switches || 0} Switch · ${data.summary?.gpus || 0} GPU · ${data.summary?.nics || 0} NIC${links.length ? ` · ${links.join(', ')}` : ''}`
  };
}

function clusterMetric(data, id) {
  const nodes = data.nodes || [];
  if (id === 'machine-config') {
    const machine = data.machine || {};
    const memoryGiB = machine.memoryKb ? Math.round(machine.memoryKb / 1024 / 1024) : null;
    const values = {
      productName:machine.productName || '', cpuVendor:machine.vendor || '', cpuModel:machine.model || '', logicalCpus:machine.logicalCpus, sockets:machine.sockets,
      coresPerSocket:machine.coresPerSocket, os:machine.os || '', kernel:machine.kernel || '',
      arch:machine.architecture || machine.systemArch || '', biosVersion:machine.biosVersion || '', memoryGiB, summary:data.summary || {}
    };
    return {
      available:Boolean(machine.model || machine.logicalCpus || machine.productName || machine.os), signature:JSON.stringify(values),
      value:`${machine.productName || '机型未知'} · ${machine.model || 'CPU 型号未知'} · ${machine.logicalCpus || '?'} 逻辑 CPU · ${memoryGiB ? `${memoryGiB} GiB` : '内存未知'} · ${data.summary?.gpus || 0} GPU · ${data.summary?.nics || 0} NIC · ${machine.os || 'OS 未知'} · ${machine.kernel || 'Kernel 未知'}`
    };
  }
  if (id === 'nic-firmware') {
    const devices = nodes.filter((node) => node.type === 'nic').map((node) => ({
      name:node.net?.name || node.ib?.hca || node.label, type:node.ib?.caType || node.description || node.net?.driver || '', firmware:node.ib?.firmware || node.net?.firmware || ''
    })).sort((left, right) => `${left.type}|${left.firmware}`.localeCompare(`${right.type}|${right.firmware}`, 'zh-CN', { numeric:true }));
    return {
      available:devices.length > 0 && devices.every((item) => item.firmware),
      signature:JSON.stringify(devices.map((item) => [item.type, item.firmware])),
      value:listMetric(devices.map((item) => `${item.name}: ${item.firmware || '未检测到'}`), '未检测到 RDMA 网卡')
    };
  }
  if (id === 'nic-speed') {
    const devices = nodes.filter((node) => node.type === 'nic').map((node) => ({
      name:node.net?.name || node.ib?.hca || node.label, transport:node.nicInfo?.transport || node.ib?.linkLayer || '', speed:node.nicInfo?.speedGbps || 0,
      label:node.nicInfo?.speedLabel || node.ib.rate || node.net?.speed || ''
    })).sort((left, right) => `${left.transport}|${left.speed}`.localeCompare(`${right.transport}|${right.speed}`, 'zh-CN', { numeric:true }));
    return {
      available:devices.length > 0 && devices.every((item) => item.speed || item.label),
      signature:JSON.stringify(devices.map((item) => [item.transport, item.speed || item.label])),
      value:listMetric(devices.map((item) => `${item.name}: ${item.label || '未检测到'}`), '未检测到 RDMA 网卡')
    };
  }
  if (id === 'gpu-firmware') {
    const devices = nodes.filter((node) => node.type === 'gpu').map((node) => ({
      label:node.label, vbios:node.gpuInfo?.vbios || '', maca:node.gpuInfo?.maca || '', kmd:node.gpuInfo?.kmd || ''
    })).sort((left, right) => `${left.vbios}|${left.maca}|${left.kmd}`.localeCompare(`${right.vbios}|${right.maca}|${right.kmd}`, 'zh-CN', { numeric:true }));
    return {
      available:devices.length > 0 && devices.every((item) => item.vbios || item.maca || item.kmd),
      signature:JSON.stringify(devices.map((item) => [item.vbios, item.maca, item.kmd])),
      value:listMetric(devices.map((item) => `${item.label}: VBIOS ${item.vbios || '?'} / MACA ${item.maca || '?'} / KMD ${item.kmd || '?'}`), '未检测到 GPU')
    };
  }
  if (id === 'gpu-model') {
    const models = nodes.filter((node) => node.type === 'gpu').map((node) => node.gpuInfo?.model || '').sort((left, right) => left.localeCompare(right, 'zh-CN', { numeric:true }));
    return { available:models.length > 0 && models.every(Boolean), signature:JSON.stringify(models), value:listMetric(models.map((model, index) => `GPU ${index}: ${model || '未检测到'}`), '未检测到 GPU') };
  }
  return topologyMetric(data);
}

function buildClusterChecks(nodes, expectedSize) {
  const definitions = [
    ['machine-config', '机器配置一致性'], ['nic-firmware', '网卡固件一致性'], ['nic-speed', '网卡速率一致性'],
    ['gpu-firmware', 'GPU 固件一致性'], ['gpu-model', 'GPU 型号一致性'], ['topology', '拓扑一致性']
  ];
  return definitions.map(([id, name]) => {
    const details = nodes.map((node) => {
      if (!node.success) return { host:node.host, available:false, error:node.error, value:'采集失败', signature:'' };
      return { host:node.host, ...clusterMetric(node.data, id) };
    });
    const collected = details.filter((item) => !item.error);
    const available = collected.filter((item) => item.available);
    const groups = new Map();
    for (const detail of available) groups.set(detail.signature, (groups.get(detail.signature) || 0) + 1);
    const baseline = [...groups].sort((left, right) => right[1] - left[1])[0]?.[0] || '';
    details.forEach((detail) => { detail.matchesBaseline = Boolean(baseline) && detail.signature === baseline; });
    let status;
    let summary;
    if (collected.length !== expectedSize) { status = 'error'; summary = `${expectedSize - collected.length} 台机器采集失败，无法完成比对`; }
    else if (available.length !== expectedSize) { status = 'unknown'; summary = `${expectedSize - available.length} 台机器缺少可比较数据`; }
    else if (groups.size === 1) { status = 'pass'; summary = `${expectedSize} 台机器一致`; }
    else { status = 'fail'; summary = `检测到 ${groups.size} 组不同结果`; }
    return { id, name, status, summary, details };
  });
}

async function collectCluster(config, onEvent) {
  const nodes = await Promise.all(config.hosts.map(async (host, index) => {
    const target = {
      kind:'remote', host, user:config.user, port:config.port, identityFile:config.identityFile,
      password:config.password, profile:config.profile, useRoot:config.useRoot
    };
    onEvent?.({ type:'node-start', host, index, totalMachines:config.size });
    try {
      const data = await collect(target, (progress) => onEvent?.({ type:'node-progress', host, index, ...progress }));
      onEvent?.({ type:'node-complete', host, index, success:true });
      return { host, success:true, data };
    } catch (error) {
      const message = errorMessage(error);
      onEvent?.({ type:'node-complete', host, index, success:false, error:message });
      return { host, success:false, error:message };
    }
  }));
  const checks = buildClusterChecks(nodes, config.size);
  return {
    size:config.size, collectedAt:new Date().toISOString(), nodes, checks,
    summary:{ successful:nodes.filter((node) => node.success).length, failed:nodes.filter((node) => !node.success).length, passed:checks.filter((check) => check.status === 'pass').length, issues:checks.filter((check) => check.status !== 'pass').length }
  };
}

function testRecipe(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('测试请求格式无效。');
  const testId = String(payload.testId || '');
  if (!TEST_LABELS.has(testId)) throw new Error('不支持该测试项。');
  if (payload.confirmed !== true) throw new Error('请先确认 GPU 空闲并接受性能测试影响。');
  const params = payload.params && typeof payload.params === 'object' && !Array.isArray(payload.params) ? payload.params : {};
  const gpu = Number(params.gpu ?? 0);
  const gpuCount = Number(params.gpuCount ?? 2);
  const gidIndex = Number(params.gidIndex ?? 3);
  const nic = String(params.nic || '');
  const peer = String(params.peer || '');
  const transport = params.transport === 'IB' ? 'IB' : 'RoCE';
  if (!Number.isInteger(gpu) || gpu < 0 || gpu > 63) throw new Error('GPU 编号必须在 0 到 63 之间。');
  if (!Number.isInteger(gpuCount) || gpuCount < 1 || gpuCount > 64) throw new Error('GPU 数量必须在 1 到 64 之间。');
  if (!Number.isInteger(gidIndex) || gidIndex < 0 || gidIndex > 255) throw new Error('GID Index 必须在 0 到 255 之间。');
  if (nic && !/^[a-zA-Z0-9_.:-]{1,64}$/.test(nic)) throw new Error('RDMA HCA 名称格式无效。');
  if (peer && !/^[a-zA-Z0-9][a-zA-Z0-9.-]{0,252}$/.test(peer)) throw new Error('对端地址格式无效。');
  const nicTests = new Set(['nic-bandwidth', 'nic-latency', 'nic-alltoall', 'host-ibrc', 'host-ibgda']);
  const peerTests = new Set(['nic-bandwidth', 'nic-latency', 'nic-alltoall']);
  const multiGpuTests = new Set(['gpu-metaxlink', 'gpu-pcie', 'host-ibrc', 'host-ibgda']);
  if (nicTests.has(testId) && !nic) throw new Error('该测试需要选择 RDMA HCA。');
  if (peerTests.has(testId) && !peer) throw new Error('该测试需要填写对端地址。');
  if (multiGpuTests.has(testId) && gpuCount < 2) throw new Error('该测试至少需要 2 张 GPU。');

  const common = [
    'set -e',
    'export MACA_PATH=/opt/maca',
    'export PATH="/opt/maca/bin:/opt/maca/mxgpu_llvm/bin:${PATH:-/usr/bin:/bin}"',
    'export LD_LIBRARY_PATH="/opt/maca/lib:/opt/maca/ompi/lib:/opt/maca/ucx/lib:/opt/maca/mxgpu_llvm/lib:${LD_LIBRARY_PATH:-}"',
    'first_exec() { for candidate in "$@"; do if [ -x "$candidate" ]; then printf "%s\\n" "$candidate"; return 0; fi; done; printf "缺少测试程序：%s\\n" "$*" >&2; return 127; }',
    `printf '=== ${TEST_LABELS.get(testId)} ===\\n'`,
    'printf "开始时间：%s\\n" "$(date -Is)"'
  ];
  const gpuPreflight = [
    'busy_gpu="$( { mx-smi -s 2>/dev/null || /opt/maca/bin/mx-smi -s 2>/dev/null || true; } | awk \'/^[[:space:]]*GPU[[:space:]]*:/ { value=$3; gsub(/%/, "", value); if ((value + 0) > 5) { print value; exit } }\')"',
    'if [ -n "$busy_gpu" ]; then printf "检测到 GPU 使用率 %s%%，为避免影响现有任务已拒绝启动。\\n" "$busy_gpu" >&2; exit 3; fi'
  ];
  let lines = [...common];
  let preview = '';
  let timeoutMs = 180_000;
  if (testId.startsWith('gpu-') || testId.startsWith('host-')) lines.push(...gpuPreflight);

  if (testId === 'gpu-vector-add') {
    timeoutMs = 90_000;
    preview = `MACA_VISIBLE_DEVICES=${gpu} vectorAdd`;
    lines.push(
      'sample_dir=/opt/maca/samples/0_Introduction/vectorAdd',
      'compiler=/opt/maca/mxgpu_llvm/bin/mxcc',
      '[ -r "$sample_dir/vectorAdd.cpp" ] || { echo "未安装 vectorAdd 示例源码。" >&2; exit 127; }',
      '[ -x "$compiler" ] || { echo "未安装 mxcc 编译器。" >&2; exit 127; }',
      'work_dir="$(mktemp -d)"',
      'trap \'rm -rf "$work_dir"\' EXIT',
      '"$compiler" -x maca -offload-arch native "$sample_dir/vectorAdd.cpp" -o "$work_dir/vectorAdd" --maca-path=/opt/maca',
      `MACA_VISIBLE_DEVICES=${gpu} "$work_dir/vectorAdd"`
    );
  } else if (testId === 'gpu-bandwidth') {
    preview = `MACA_VISIBLE_DEVICES=${gpu} TransferBenchMaca p2p`;
    lines.push(
      'transfer="$(first_exec /opt/maca/tools/communication/p2p/TransferBenchMaca /opt/maca/samples/mccl_tests/benchmark/TransferBenchMaca)"',
      `export MACA_VISIBLE_DEVICES=${gpu} NUM_CPU_DEVICES=1 NUM_GPU_DEVICES=1 NUM_ITERATIONS=20 NUM_WARMUPS=3 P2P_MODE=1 DATA_CHECK=1`,
      'exec "$transfer" p2p'
    );
  } else if (testId === 'gpu-metaxlink') {
    preview = `NUM_GPU_DEVICES=${gpuCount} A2A_DIRECT=1 TransferBenchMaca a2a`;
    lines.push(
      'transfer="$(first_exec /opt/maca/tools/communication/p2p/TransferBenchMaca /opt/maca/samples/mccl_tests/benchmark/TransferBenchMaca)"',
      `export NUM_CPU_DEVICES=0 NUM_GPU_DEVICES=${gpuCount} NUM_ITERATIONS=20 NUM_WARMUPS=3 A2A_DIRECT=1 SHOW_LINK_TYPE=1 DATA_CHECK=1`,
      'exec "$transfer" a2a'
    );
  } else if (testId === 'gpu-pcie') {
    preview = `NUM_GPU_DEVICES=${gpuCount} A2A_DIRECT=0 USE_GPU_DMA=1 TransferBenchMaca a2a`;
    lines.push(
      'transfer="$(first_exec /opt/maca/tools/communication/p2p/TransferBenchMaca /opt/maca/samples/mccl_tests/benchmark/TransferBenchMaca)"',
      `export NUM_CPU_DEVICES=0 NUM_GPU_DEVICES=${gpuCount} NUM_ITERATIONS=20 NUM_WARMUPS=3 A2A_DIRECT=0 USE_GPU_DMA=1 SHOW_LINK_TYPE=1 DATA_CHECK=1`,
      'exec "$transfer" a2a'
    );
  } else if (testId === 'nic-bandwidth') {
    preview = `ib_write_bw -a -F --report_gbits -d ${nic}${transport === 'RoCE' ? ` -x ${gidIndex}` : ''} ${peer}`;
    lines.push(
      'ib_write="$(first_exec /opt/maca/tools/communication/rdma/perftest/tests/ib_write_bw /opt/maca/samples/mccl_tests/ib_perf/tests/ib_write_bw /usr/bin/ib_write_bw)"',
      transport === 'RoCE' ? `exec "$ib_write" -a -F --report_gbits -d ${nic} -x ${gidIndex} ${peer}` : `exec "$ib_write" -a -F --report_gbits -d ${nic} ${peer}`
    );
  } else if (testId === 'nic-latency') {
    preview = `ib_read_lat -a -F -d ${nic}${transport === 'RoCE' ? ` -x ${gidIndex}` : ''} ${peer}`;
    lines.push(
      'ib_read_lat="$(first_exec /opt/maca/tools/communication/rdma/perftest/tests/ib_read_lat /opt/maca/samples/mccl_tests/ib_perf/tests/ib_read_lat /usr/bin/ib_read_lat)"',
      transport === 'RoCE' ? `exec "$ib_read_lat" -a -F -d ${nic} -x ${gidIndex} ${peer}` : `exec "$ib_read_lat" -a -F -d ${nic} ${peer}`
    );
  } else if (testId === 'nic-alltoall') {
    timeoutMs = 240_000;
    preview = `mpirun -n 2 -host 127.0.0.1:1,${peer}:1 TransferBenchMaca ib`;
    lines.push(
      'mpi="$(first_exec /opt/maca/ompi/bin/mpirun /usr/bin/mpirun)"',
      'transfer="$(first_exec /opt/maca/tools/communication/p2p/TransferBenchMaca /opt/maca/samples/mccl_tests/benchmark/TransferBenchMaca)"',
      'ib_exec_path=/opt/maca/tools/communication/rdma/perftest/tests',
      '[ -x "$ib_exec_path/ib_write_bw" ] || ib_exec_path=/opt/maca/samples/mccl_tests/ib_perf/tests',
      `export IB_PORT=${nic} IB_EXE_PATH="$ib_exec_path" IB_EXE_NAME=ib_write_bw IB_TEST_MODE=1 HOST_NAME="127.0.0.1:1,${peer}:1"`,
      `exec "$mpi" --allow-run-as-root -n 2 -host "127.0.0.1:1,${peer}:1" -mca pml ^ucx -mca osc ^ucx -mca btl ^openib -x LD_LIBRARY_PATH -x IB_PORT -x IB_EXE_PATH -x IB_EXE_NAME -x IB_TEST_MODE -x HOST_NAME "$transfer" ib`
    );
  } else if (testId === 'host-ibrc') {
    timeoutMs = 300_000;
    preview = `MCCL_P2P_LEVEL=LOC MCCL_IB_HCA=${nic} mpirun -n ${gpuCount} alltoall_perf`;
    lines.push(
      'mpi="$(first_exec /opt/maca/ompi/bin/mpirun /usr/bin/mpirun)"',
      'perf="$(first_exec /opt/maca/tools/communication/mccl/mccl_perf/alltoall_perf /opt/maca/samples/mccl_tests/perf/mccl_perf/alltoall_perf)"',
      `export MCCL_IB_HCA=${nic} MCCL_P2P_LEVEL=LOC MCCL_SHM_DISABLE=1 MCCL_NET_GDR_LEVEL=SYS`,
      `exec "$mpi" --allow-run-as-root -n ${gpuCount} -mca pml ^ucx -mca osc ^ucx -mca btl ^openib -x LD_LIBRARY_PATH -x MCCL_IB_HCA -x MCCL_P2P_LEVEL -x MCCL_SHM_DISABLE -x MCCL_NET_GDR_LEVEL "$perf" -b 1M -e 256M -f 2 -g 1 -n 5`
    );
  } else if (testId === 'host-ibgda') {
    timeoutMs = 300_000;
    preview = `MXSHMEM_DISABLE_P2P=1 MXSHMEM_HCA_LIST=${nic}:1 python test_internode.py -n ${gpuCount}`;
    lines.push(
      'python_bin="$(command -v python3 || command -v python || true)"',
      '[ -n "$python_bin" ] || { echo "未安装 Python。" >&2; exit 127; }',
      'test_file=/opt/maca/tools/communication/mxdeepep/tests/test_internode.py',
      '[ -r "$test_file" ] || { echo "未安装 mxdeepep IBGDA 测试。" >&2; exit 127; }',
      `export MXSHMEM_DISABLE_P2P=1 MXSHMEM_HCA_LIST=${nic}:1 MXDEEPEP_EXT_MAX_MXL_PEERS=4`,
      nic.startsWith('metax_rdma_') ? 'export MXSHMEM_GDA_PROVIDER=mrdma' : ':',
      `exec "$python_bin" "$test_file" -n ${gpuCount} -t 1024 -d 4096 -k 8 -e 256`
    );
  }
  lines.push('printf "结束时间：%s\\n" "$(date -Is)"');
  return { testId, label: TEST_LABELS.get(testId), script: `${lines.join('\n')}\n`, preview, timeoutMs };
}

function shellSingleQuote(value) {
  return "'" + String(value).split("'").join("'\"'\"'") + "'";
}

function singleEpChoiceList(value, label, allowedValues) {
  const entries = Array.isArray(value)
    ? value
    : (typeof value === 'string' ? value.split(/[,，\s]+/).filter(Boolean) : []);
  if (!entries.length) throw new Error(label + '不能为空。');
  const allowed = new Set(allowedValues);
  const values = [];
  for (const entry of entries) {
    const text = String(entry).trim();
    if (!/^\d+$/.test(text)) throw new Error(label + '只能填写整数并用逗号分隔。');
    const number = Number(text);
    if (!Number.isSafeInteger(number) || !allowed.has(number)) {
      throw new Error(label + '仅支持：' + allowedValues.join(', ') + '。');
    }
    if (!values.includes(number)) values.push(number);
  }
  return values;
}

function singleEpRequest(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('EP 测试请求格式无效。');
  if (payload.confirmed !== true) throw new Error('请先确认 GPU 空闲并接受性能测试影响。');
  const testType = String(payload.testType || '');
  if (!Object.hasOwn(SINGLE_EP_TOKENS, testType)) throw new Error('不支持该 SingleEP 测试类型。');
  const ranks = singleEpChoiceList(payload.ranks, 'Rank 数量', SINGLE_EP_RANKS);
  const tokens = singleEpChoiceList(payload.tokens, 'Token 数量', SINGLE_EP_TOKENS[testType]);
  const hiddenText = String(payload.hidden ?? '').trim();
  if (!/^\d+$/.test(hiddenText)) throw new Error('Hidden Size 必须是整数。');
  const hidden = Number(hiddenText);
  if (!Number.isSafeInteger(hidden) || hidden < 256 || hidden > 65_536 || hidden % 256 !== 0) {
    throw new Error('Hidden Size 必须是 256 到 65536 之间的 256 倍数。');
  }
  const compatibleRanks = testType === 'intranode' ? [2, 4, 8] : (testType === 'internode' ? [16] : SINGLE_EP_RANKS);
  const incompatible = ranks.filter((rank) => !compatibleRanks.includes(rank));
  if (incompatible.length) {
    throw new Error(SINGLE_EP_TYPE_LABELS[testType] + ' 的 Rank 数量仅支持：' + compatibleRanks.join(', ') + '。');
  }
  const cases = [];
  for (const rank of ranks) {
    for (const token of tokens) cases.push({ rank, tokens:token, hidden });
  }
  if (cases.length > 42) throw new Error('单次最多运行 42 组参数组合。');
  return { testType, typeLabel:SINGLE_EP_TYPE_LABELS[testType], ranks, tokens, hidden, cases };
}

function singleEpCaseRecipe(config, testCase) {
  let launcher;
  let args;
  if (config.testType === 'low-latency') {
    launcher = 'run.sh';
    args = [
      String(testCase.rank), '--', '--num-tokens', String(testCase.tokens),
      '--hidden', String(testCase.hidden), '--warmup', '20', '--tests', '30'
    ];
  } else if (config.testType === 'intranode') {
    launcher = 'run_intranode.sh';
    args = [
      String(testCase.rank), '--', '--num-tokens', String(testCase.tokens),
      '--hidden', String(testCase.hidden)
    ];
  } else {
    launcher = 'run_internode.sh';
    args = ['--', '--num-tokens', String(testCase.tokens), '--hidden', String(testCase.hidden)];
  }
  const printableArgs = args.join(' ');
  const preview = 'bash ' + SINGLE_EP_TEST_DIR + '/' + launcher + ' ' + printableArgs;
  const lines = [
    'set -e',
    'export LC_ALL=C',
    'test_dir=' + shellSingleQuote(SINGLE_EP_TEST_DIR),
    '[ -r "$test_dir/' + launcher + '" ] || { printf "SingleEP 启动器不存在或不可读：%s\\n" "$test_dir/' + launcher + '" >&2; exit 127; }',
    'printf "=== SingleEP ' + config.typeLabel + ' | ranks=' + testCase.rank + ' tokens=' + testCase.tokens + ' hidden=' + testCase.hidden + ' ===\\n"',
    'exec bash "$test_dir/' + launcher + '" ' + printableArgs
  ];
  return {
    testId:'singleep',
    label:'SingleEP ' + config.typeLabel,
    script:lines.join('\n') + '\n',
    preview,
    timeoutMs:SINGLE_EP_CASE_TIMEOUT_MS
  };
}

function finiteMetric(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function parseSingleEpOutput(testType, output, testCase) {
  if (testType === 'low-latency') {
    const means = {};
    for (const match of output.matchAll(/\[summary\]\s+(dispatch|combine|pair)\s+us:[^\n]*?\bmean=\s*([0-9.eE+-]+)/gi)) {
      means[match[1].toLowerCase()] = finiteMetric(match[2]);
    }
    const collective = output.match(/\[collective\]\s+pair_max=\s*([0-9.eE+-]+)\s+us\s+effective_bw=\s*([0-9.eE+-]+)\s+GB\/s/i);
    const configuration = output.match(/num_ranks=(\d+)\s+num_tokens=(\d+)\s+hidden=(\d+)/i);
    const matchesRequest = configuration && Number(configuration[1]) === testCase.rank && Number(configuration[2]) === testCase.tokens && Number(configuration[3]) === testCase.hidden;
    return {
      passed:Boolean(matchesRequest) && /===\s*RESULT:\s*PASS\s*===/i.test(output),
      metrics:{
        latencyUs:means.pair ?? null,
        dispatchUs:means.dispatch ?? null,
        combineUs:means.combine ?? null,
        pairMaxUs:collective ? finiteMetric(collective[1]) : null,
        bandwidthGbps:collective ? finiteMetric(collective[2]) : null,
        basis:'rank-mean'
      }
    };
  }
  const normal = output.match(/(intranode|internode)\s+PASS:\s+ranks=(\d+)\s+tokens=(\d+)\s+hidden=(\d+)\s+topk=(\d+)\s+sms=(\d+)\s+dispatch_max=([0-9.eE+-]+)\s+ms\s+combine_max=([0-9.eE+-]+)\s+ms/i);
  const matchesRequest = normal && normal[1].toLowerCase() === testType && Number(normal[2]) === testCase.rank && Number(normal[3]) === testCase.tokens && Number(normal[4]) === testCase.hidden;
  if (!matchesRequest) {
    return {
      passed:false,
      metrics:{ latencyUs:null, dispatchUs:null, combineUs:null, pairMaxUs:null, bandwidthGbps:null, basis:'rank-max' }
    };
  }
  const tokens = Number(normal[3]);
  const hidden = Number(normal[4]);
  const topk = Number(normal[5]);
  const dispatchUs = finiteMetric(Number(normal[7]) * 1000);
  const combineUs = finiteMetric(Number(normal[8]) * 1000);
  const latencyUs = dispatchUs === null || combineUs === null ? null : dispatchUs + combineUs;
  const pairBytes = 4 * tokens * hidden * topk;
  return {
    passed:true,
    metrics:{
      latencyUs,
      dispatchUs,
      combineUs,
      pairMaxUs:latencyUs,
      bandwidthGbps:latencyUs > 0 ? pairBytes / (latencyUs * 1000) : null,
      basis:'rank-max-derived-bandwidth'
    }
  };
}

function singleEpFailureMessage(launch, code, signal, parsed) {
  if (launch.command === 'sshpass' && code === 5) return 'SSH 密码认证失败，请检查用户名和密码。';
  if (launch.command === 'sshpass' && code === 6) return 'SSH 新主机密钥自动记录失败，请检查服务账号的 ~/.ssh/known_hosts 写权限。';
  if (launch.command === 'sshpass' && code === 7) return 'SSH 主机密钥已变更，请检查 known_hosts。';
  if (code === 0 && !parsed.passed) return '进程已退出，但未找到 SingleEP PASS 结果。';
  return '进程退出码 ' + (code ?? '-') + (signal ? '，信号 ' + signal : '');
}

function executeSingleEpCase(config, testCase, target, position, total, res, batch) {
  return new Promise((resolve) => {
    const recipe = singleEpCaseRecipe(config, testCase);
    const launch = testLaunch(target, recipe.script);
    const hasPasswordFd = Boolean(launch.fdPassword);
    const child = spawn(launch.command, launch.args, {
      detached:true,
      stdio:hasPasswordFd ? ['pipe', 'pipe', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe']
    });
    batch.child = child;
    const startedAt = Date.now();
    let caseOutput = '';
    let caseOutputSize = 0;
    let terminalError = null;
    let finished = false;
    let forceKillTimer = null;
    sendStreamEvent(res, {
      type:'case-start', index:position, total, testType:config.testType,
      typeLabel:config.typeLabel, rank:testCase.rank, tokens:testCase.tokens,
      hidden:testCase.hidden, command:recipe.preview, timeoutSeconds:recipe.timeoutMs / 1000
    });
    const stop = (error) => {
      if (finished || terminalError) return;
      terminalError = error;
      terminateProcessGroup(child);
      forceKillTimer = setTimeout(() => terminateProcessGroup(child, 'SIGKILL'), 1_500);
      forceKillTimer.unref?.();
    };
    const output = (stream, chunk) => {
      if (terminalError) return;
      const text = chunk.toString('utf8');
      caseOutput += text;
      caseOutputSize += chunk.length;
      batch.outputSize += chunk.length;
      if (caseOutputSize > MAX_SINGLE_EP_CASE_OUTPUT) return stop(new Error('本轮日志超过 2 MiB，已停止该轮测试。'));
      if (batch.outputSize > MAX_SINGLE_EP_OUTPUT) {
        batch.fatalError = new Error('SingleEP 批量日志超过 8 MiB，任务已停止。');
        return stop(batch.fatalError);
      }
      sendStreamEvent(res, { type:'output', index:position, stream, text });
    };
    child.stdout.on('data', (chunk) => output('stdout', chunk));
    child.stderr.on('data', (chunk) => output('stderr', chunk));
    child.stdin.on('error', () => {});
    child.on('error', (error) => stop(error));
    if (hasPasswordFd) {
      child.stdio[3].on('error', () => {});
      child.stdio[3].end(launch.fdPassword + '\n');
    }
    child.stdin.end(launch.input);
    const timeout = setTimeout(() => stop(new Error('本轮测试超过 ' + (recipe.timeoutMs / 1000) + ' 秒，已停止。')), recipe.timeoutMs);
    child.on('close', (code, signal) => {
      finished = true;
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (batch.child === child) batch.child = null;
      const parsed = parseSingleEpOutput(config.testType, caseOutput, testCase);
      const success = !terminalError && code === 0 && parsed.passed;
      resolve({
        index:position, total, testType:config.testType, typeLabel:config.typeLabel,
        rank:testCase.rank, tokens:testCase.tokens, hidden:testCase.hidden,
        success, status:success ? 'passed' : (batch.cancelled ? 'stopped' : 'failed'),
        code, signal, durationMs:Date.now() - startedAt, metrics:parsed.metrics,
        error:success ? '' : (terminalError?.message || singleEpFailureMessage(launch, code, signal, parsed))
      });
    });
  });
}

async function executeSingleEpBatch(config, target, res) {
  const batch = {
    testId:'singleep',
    label:'SingleEP ' + config.typeLabel + '（' + config.cases.length + ' 组）',
    child:null,
    startedAt:Date.now(),
    outputSize:0,
    fatalError:null,
    cancelled:false,
    cancelKillTimer:null
  };
  activePerformanceTest = batch;
  const results = [];
  const onClose = () => {
    if (res.writableEnded) return;
    batch.cancelled = true;
    if (batch.child) {
      terminateProcessGroup(batch.child);
      batch.cancelKillTimer = setTimeout(() => terminateProcessGroup(batch.child, 'SIGKILL'), 1_500);
      batch.cancelKillTimer.unref?.();
    }
  };
  res.on('close', onClose);
  sendStreamEvent(res, {
    type:'start', testId:'singleep', label:batch.label, testType:config.testType,
    typeLabel:config.typeLabel, total:config.cases.length,
    timeoutSeconds:SINGLE_EP_CASE_TIMEOUT_MS / 1000
  });
  try {
    for (let index = 0; index < config.cases.length; index += 1) {
      if (batch.cancelled || batch.fatalError) break;
      const result = await executeSingleEpCase(config, config.cases[index], target, index + 1, config.cases.length, res, batch);
      results.push(result);
      if (!batch.cancelled) sendStreamEvent(res, { type:'case-result', result });
    }
    if (!batch.cancelled) {
      const passed = results.filter((result) => result.success).length;
      const failed = results.length - passed;
      sendStreamEvent(res, {
        type:'result',
        success:failed === 0 && results.length === config.cases.length && !batch.fatalError,
        total:config.cases.length,
        completed:results.length,
        passed,
        failed,
        durationMs:Date.now() - batch.startedAt,
        error:batch.fatalError?.message || '',
        results
      });
      if (!res.writableEnded) res.end();
    }
  } catch (error) {
    if (!batch.cancelled) {
      const passed = results.filter((result) => result.success).length;
      sendStreamEvent(res, {
        type:'result', success:false, total:config.cases.length, completed:results.length,
        passed, failed:results.length - passed, durationMs:Date.now() - batch.startedAt,
        error:errorMessage(error), results
      });
      if (!res.writableEnded) res.end();
    }
  } finally {
    res.off('close', onClose);
    if (batch.cancelKillTimer) clearTimeout(batch.cancelKillTimer);
    if (activePerformanceTest === batch) activePerformanceTest = null;
  }
}

function testLaunch(target, script) {
  if (!target || typeof target !== 'object' || Array.isArray(target)) throw new Error('测试目标格式无效。');
  if (!['local', 'remote'].includes(target.kind)) throw new Error('测试目标类型无效。');
  const password = typeof target.password === 'string' ? target.password : '';
  if (password.length > 512 || /[\r\n\0]/.test(password)) throw new Error('密码格式无效。');
  if (target.kind !== 'remote') return { command: 'bash', args: ['-s'], input: script, fdPassword: '' };
  if (!/^[a-zA-Z0-9][a-zA-Z0-9.:-]*$/.test(target.host || '')) throw new Error('远程地址格式无效。');
  if (target.user && !/^[a-z_][a-z0-9_-]*$/i.test(target.user)) throw new Error('SSH 用户名格式无效。');
  const port = Number(target.port) || 22;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('SSH 端口必须在 1 到 65535 之间。');
  if (target.identityFile && (typeof target.identityFile !== 'string' || target.identityFile.length > 1024 || /[\r\n\0]/.test(target.identityFile))) throw new Error('私钥路径格式无效。');
  const sshArgs = [
    '-o', `BatchMode=${password ? 'no' : 'yes'}`,
    '-o', 'NumberOfPasswordPrompts=1',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ConnectTimeout=8',
    '-p', String(port)
  ];
  if (target.identityFile) sshArgs.push('-i', target.identityFile);
  sshArgs.push(`${target.user ? `${target.user}@` : ''}${target.host}`, 'bash -s');
  return password
    ? { command: 'sshpass', args: ['-d', '3', 'ssh', ...sshArgs], input: script, fdPassword: password }
    : { command: 'ssh', args: sshArgs, input: script, fdPassword: '' };
}

function terminateProcessGroup(child, signal = 'SIGTERM') {
  if (!child?.pid) return;
  try { process.kill(-child.pid, signal); }
  catch { try { child.kill(signal); } catch {} }
}

function executePerformanceTest(recipe, launch, req, res) {
  return new Promise((resolve) => {
    const hasPasswordFd = Boolean(launch.fdPassword);
    const child = spawn(launch.command, launch.args, { detached: true, stdio: hasPasswordFd ? ['pipe', 'pipe', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'] });
    const startedAt = Date.now();
    let outputSize = 0;
    let terminalError = null;
    let finished = false;
    let forceKillTimer = null;
    activePerformanceTest = { testId: recipe.testId, label: recipe.label, child, startedAt };
    sendStreamEvent(res, { type: 'start', testId: recipe.testId, label: recipe.label, command: recipe.preview, timeoutSeconds: recipe.timeoutMs / 1000 });
    const stop = (error) => {
      if (finished || terminalError) return;
      terminalError = error;
      terminateProcessGroup(child);
      forceKillTimer = setTimeout(() => terminateProcessGroup(child, 'SIGKILL'), 1_500);
      forceKillTimer.unref?.();
    };
    const output = (stream, chunk) => {
      outputSize += chunk.length;
      if (outputSize > MAX_TEST_OUTPUT) return stop(new Error('测试日志超过 4 MiB，任务已停止。'));
      sendStreamEvent(res, { type: 'output', stream, text: chunk.toString('utf8') });
    };
    child.stdout.on('data', (chunk) => output('stdout', chunk));
    child.stderr.on('data', (chunk) => output('stderr', chunk));
    child.stdin.on('error', () => {});
    child.on('error', (error) => stop(error));
    if (hasPasswordFd) { child.stdio[3].on('error', () => {}); child.stdio[3].end(`${launch.fdPassword}\n`); }
    child.stdin.end(launch.input);
    const timeout = setTimeout(() => stop(new Error(`测试超过 ${recipe.timeoutMs / 1000} 秒，已停止。`)), recipe.timeoutMs);
    res.on('close', () => { if (!finished) stop(new Error('浏览器已断开，测试任务已停止。')); });
    child.on('close', (code, signal) => {
      finished = true;
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (activePerformanceTest?.child === child) activePerformanceTest = null;
      const durationMs = Date.now() - startedAt;
      if (terminalError) sendStreamEvent(res, { type: 'error', error: terminalError.message, durationMs });
      else sendStreamEvent(res, { type: 'result', success: code === 0, code, signal, durationMs });
      if (!res.writableEnded) res.end();
      resolve();
    });
  });
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

function errorMessage(error) {
  return error.stderr?.trim() || error.message || '采集失败。';
}

function sendStreamEvent(res, event) {
  if (!res.destroyed) res.write(`${JSON.stringify(event)}\n`);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (req.method === 'POST' && url.pathname === '/api/scan') {
    let body = '';
    for await (const chunk of req) { body += chunk; if (body.length > 10000) return sendJson(res, 413, { error: '请求过大。' }); }
    let target;
    try { target = JSON.parse(body || '{}'); }
    catch { return sendJson(res, 400, { error: '请求不是有效的 JSON。' }); }
    if (req.headers.accept?.includes('application/x-ndjson')) {
      res.writeHead(200, {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Cache-Control': 'no-store, no-transform',
        'X-Accel-Buffering': 'no'
      });
      res.flushHeaders?.();
      sendStreamEvent(res, { type: 'progress', completed: 0, total: COLLECTION_TASKS.length, label: '建立连接' });
      try {
        const data = await collect(target, (progress) => sendStreamEvent(res, { type: 'progress', ...progress }));
        sendStreamEvent(res, { type: 'result', data });
      } catch (error) {
        sendStreamEvent(res, { type: 'error', error: errorMessage(error) });
      }
      res.end();
    } else {
      try { sendJson(res, 200, await collect(target)); }
      catch (error) { sendJson(res, 500, { error: errorMessage(error) }); }
    }
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/cluster/scan') {
    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 20_000) return sendJson(res, 413, { error: '请求过大。' });
    }
    let payload;
    try { payload = JSON.parse(body || '{}'); }
    catch { return sendJson(res, 400, { error: '请求不是有效的 JSON。' }); }
    let config;
    try { config = clusterRequest(payload); }
    catch (error) { return sendJson(res, 400, { error: errorMessage(error) }); }
    if (activeClusterScan) return sendJson(res, 409, { error: '已有小规模集群采集正在运行，请等待完成。' });

    activeClusterScan = true;
    res.writeHead(200, {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      'X-Accel-Buffering': 'no'
    });
    res.flushHeaders?.();
    try {
      const data = await collectCluster(config, (event) => sendStreamEvent(res, event));
      sendStreamEvent(res, { type: 'result', data });
    } catch (error) {
      sendStreamEvent(res, { type: 'error', error: errorMessage(error) });
    } finally {
      activeClusterScan = false;
      if (!res.writableEnded) res.end();
    }
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/ep/singleep/run') {
    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 20_000) return sendJson(res, 413, { error: '请求过大。' });
    }
    let payload;
    try { payload = JSON.parse(body || '{}'); }
    catch { return sendJson(res, 400, { error: '请求不是有效的 JSON。' }); }
    if (activePerformanceTest) {
      return sendJson(res, 409, {
        error: `已有测试正在运行：${activePerformanceTest.label}。请等待完成或在启动该测试的页面中停止。`
      });
    }
    let config;
    try {
      config = singleEpRequest(payload);
      testLaunch(payload.target, 'true\n');
    } catch (error) {
      return sendJson(res, 400, { error: errorMessage(error) });
    }
    res.writeHead(200, {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      'X-Accel-Buffering': 'no'
    });
    res.flushHeaders?.();
    await executeSingleEpBatch(config, payload.target, res);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/tests/run') {
    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 20_000) return sendJson(res, 413, { error: '请求过大。' });
    }
    let payload;
    try { payload = JSON.parse(body || '{}'); }
    catch { return sendJson(res, 400, { error: '请求不是有效的 JSON。' }); }
    if (activePerformanceTest) {
      return sendJson(res, 409, {
        error: `已有测试正在运行：${activePerformanceTest.label}。请等待完成或在启动该测试的页面中停止。`
      });
    }
    let recipe;
    let launch;
    try {
      recipe = testRecipe(payload);
      launch = testLaunch(payload.target, recipe.script);
    } catch (error) {
      return sendJson(res, 400, { error: errorMessage(error) });
    }
    res.writeHead(200, {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      'X-Accel-Buffering': 'no'
    });
    res.flushHeaders?.();
    await executePerformanceTest(recipe, launch, req, res);
    return;
  }
  const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  const fullPath = path.resolve(PUBLIC_DIR, file);
  if (!fullPath.startsWith(PUBLIC_DIR) || !fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) { res.writeHead(404); return res.end('Not found'); }
  const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8' };
  res.writeHead(200, { 'Content-Type': types[path.extname(fullPath)] || 'application/octet-stream' });
  fs.createReadStream(fullPath).pipe(res);
});
server.listen(PORT, HOST, () => console.log(`Machine Topology: http://${HOST}:${PORT}`));
