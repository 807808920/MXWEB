const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
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
const SINGLE_EP_STAGE_TIMEOUT_MS = 180_000;
const TEST_STOP_GRACE_MS = 1_500;
const TEST_CLEANUP_TIMEOUT_MS = 8_000;
const IB_WRITE_BW_PATH = '/opt/maca/tools/communication/rdma/perftest/tests/ib_write_bw';
const MACA_MPIRUN_PATH = '/opt/maca/ompi/bin/mpirun';
const MCCL_ALLTOALL_PATH = '/opt/maca/samples/mccl_tests/perf/mccl_perf/alltoall_perf';
const MACA_LIBRARY_PATH_PREVIEW = 'export LD_LIBRARY_PATH=/opt/maca/lib:$LD_LIBRARY_PATH';
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
const SINGLE_EP_RUNTIME_PROGRAMS = {
  'low-latency': { launcher:'run.sh', executable:'test_low_latency' },
  intranode: { launcher:'run_intranode.sh', executable:'test_intranode' },
  internode: { launcher:'run_internode.sh', executable:'test_internode' }
};
const COLLECTION_TASKS = [
  ['META', '主机信息'], ['CPU', 'CPU / NUMA'], ['CPU_GOV', 'CPU 性能模式'],
  ['SYSTEM', '系统环境'], ['DMESG', '内核错误'], ['PCI_CTL', 'PCIe 控制'],
  ['PCI', 'PCIe 拓扑'], ['NET', '网卡设备'], ['IB', 'InfiniBand 状态'],
  ['IB_NET', 'RDMA 网口映射'], ['OFED', 'OFED 版本'], ['GIDS', 'GID 配置'],
  ['ROCE', 'RoCE 配置'], ['GPU_TOPO', 'GPU 拓扑'], ['GPU_NIC_TOPO', 'GPU / 网卡距离'], ['GPU_HEALTH', 'GPU 状态'],
  ['MXLK', 'MetaxLink'], ['GPU_PCIE', 'GPU PCIe'], ['MACA', 'GPU 型号']
];
const COLLECTION_TASK_LABELS = new Map(COLLECTION_TASKS);
const TEST_LABELS = new Map([
  ['gpu-vector-add', 'GPU vectorAdd 测试'],
  ['nic-p2p', '网卡 P2P 测试'],
  ['nic-alltoall', '网卡 alltoall 测试'],
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
  gdr_perftest=/opt/maca/tools/communication/rdma/perftest/tests/ib_write_bw
  if [ -x "$gdr_perftest" ]; then
    gdr_perftest_path=$gdr_perftest
    if "$gdr_perftest" --help 2>&1 | grep -q -- '--use_maca_dmabuf'; then gdr_perftest_dmabuf=yes; else gdr_perftest_dmabuf=no; fi
  fi

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
  for container_runtime in docker podman nerdctl; do
    container_cli=$(command -v "$container_runtime" 2>/dev/null || true)
    [ -n "$container_cli" ] || continue
    if command -v timeout >/dev/null 2>&1; then
      container_rows=$(timeout 4 "$container_cli" ps --no-trunc --format '{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Status}}' 2>/dev/null)
    else
      container_rows=$("$container_cli" ps --no-trunc --format '{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Status}}' 2>/dev/null)
    fi
    container_rc=$?
    if [ "$container_rc" -eq 0 ]; then
      printf 'container_runtime\t%s\tavailable\n' "$container_runtime"
      printf '%s\n' "$container_rows" | while IFS=$'\t' read -r container_id container_name container_image container_status; do
        [ -n "$container_id" ] || continue
        printf 'container\t%s\t%s\t%s\t%s\t%s\n' "$container_runtime" "$container_id" "$container_name" "$container_image" "$container_status"
      done
      if command -v timeout >/dev/null 2>&1; then
        container_image_rows=$(timeout 6 "$container_cli" image ls --no-trunc --format '{{.ID}}\t{{.Repository}}\t{{.Tag}}\t{{.Size}}' 2>/dev/null)
      else
        container_image_rows=$("$container_cli" image ls --no-trunc --format '{{.ID}}\t{{.Repository}}\t{{.Tag}}\t{{.Size}}' 2>/dev/null)
      fi
      container_image_rc=$?
      if [ "$container_image_rc" -eq 0 ]; then
        printf 'container_image_runtime\t%s\tavailable\n' "$container_runtime"
        printf '%s\n' "$container_image_rows" | while IFS=$'\t' read -r image_id image_repository image_tag image_size; do
          [ -n "$image_id" ] || continue
          printf 'container_image\t%s\t%s\t%s\t%s\t%s\n' "$container_runtime" "$image_id" "$image_repository" "$image_tag" "$image_size"
        done
      else
        printf 'container_image_runtime\t%s\tunavailable\n' "$container_runtime"
      fi
    else
      printf 'container_runtime\t%s\tunavailable\n' "$container_runtime"
    fi
  done
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
gpu_nic_topo() { mx-smi topo -n 2>&1 || /opt/maca/bin/mx-smi topo -n 2>&1; }
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
collect_task GPU_NIC_TOPO GPU_NIC_TOPO gpu_nic_topo &
collect_task GPU_HEALTH GPU_HEALTH gpu_health &
collect_task MXLK MXLK mxlk &
collect_task GPU_PCIE GPU_PCIE gpu_pcie &
collect_task MACA MACA macainfo &
wait
for section in META CPU CPU_GOV SYSTEM DMESG PCI_CTL PCI NET IB IB_NET OFED GIDS ROCE GPU_TOPO GPU_NIC_TOPO GPU_HEALTH MXLK GPU_PCIE MACA; do printf '__%s__\n' "$section"; cat "$tmp/$section" 2>/dev/null; done
true`;

function parseSections(output) {
  const names = ['META', 'CPU', 'CPU_GOV', 'SYSTEM', 'DMESG', 'PCI', 'PCI_CTL', 'NET', 'IB', 'IB_NET', 'OFED', 'GIDS', 'ROCE', 'GPU_TOPO', 'GPU_NIC_TOPO', 'GPU_HEALTH', 'MXLK', 'GPU_PCIE', 'MACA'];
  const sections = Object.fromEntries(names.map((name) => [name, '']));
  let current = null;
  for (const line of output.split(/\r?\n/)) {
    const marker = /^__(META|CPU|CPU_GOV|SYSTEM|DMESG|PCI|PCI_CTL|NET|IB|IB_NET|OFED|GIDS|ROCE|GPU_TOPO|GPU_NIC_TOPO|GPU_HEALTH|MXLK|GPU_PCIE|MACA)__$/.exec(line);
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

function parseContainers(text) {
  const runtimes = [];
  const items = [];
  const images = new Map();
  const seen = new Set();
  for (const line of text.split(/\r?\n/)) {
    const fields = line.split('\t');
    if (fields[0] === 'container_runtime') {
      const runtime = fields[1] || '';
      if (!['docker', 'podman', 'nerdctl'].includes(runtime) || runtimes.some((item) => item.name === runtime)) continue;
      runtimes.push({ name:runtime, available:fields[2] === 'available' });
      continue;
    }
    if (fields[0] === 'container_image_runtime') {
      const runtime = fields[1] || '';
      if (!['docker', 'podman', 'nerdctl'].includes(runtime)) continue;
      let entry = runtimes.find((item) => item.name === runtime);
      if (!entry) { entry = { name:runtime, available:false }; runtimes.push(entry); }
      entry.imagesAvailable = fields[2] === 'available';
      continue;
    }
    if (fields[0] === 'container_image') {
      const [runtime, rawId, repository = '', tag = '', size = ''] = fields.slice(1);
      const id = String(rawId || '').toLowerCase();
      if (!['docker', 'podman', 'nerdctl'].includes(runtime) || !/^(?:sha256:)?[a-f0-9]{12,64}$/.test(id)) continue;
      const key = `${runtime}:${id}`;
      const reference = repository && repository !== '<none>'
        ? `${repository}${tag && tag !== '<none>' ? `:${tag}` : ''}`
        : '';
      if (!images.has(key)) images.set(key, { runtime, id, references:[], size:size.slice(0, 64) });
      const image = images.get(key);
      if (reference && !image.references.includes(reference)) image.references.push(reference.slice(0, 512));
      continue;
    }
    if (fields[0] !== 'container') continue;
    const [runtime, id, name = '', image = '', status = ''] = fields.slice(1);
    const key = `${runtime}:${id}`;
    if (!['docker', 'podman', 'nerdctl'].includes(runtime) || !/^[a-f0-9]{12,64}$/i.test(id || '') || seen.has(key)) continue;
    seen.add(key);
    items.push({ runtime, id:id.toLowerCase(), name:name.slice(0, 128), image:image.slice(0, 512), status:status.slice(0, 256) });
  }
  return { runtimes, items, images:[...images.values()] };
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
  const perftestDmaBufReady = evidence.perftestDmaBuf === 'yes' && system.get('gdr_perftest_path') === IB_WRITE_BW_PATH;
  const preferredMode = peerMemReady ? 'peermem' : (dmaBufReady && perftestDmaBufReady ? 'dmabuf' : '');
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
  const activation = preferredMode === 'peermem'
    ? '当前使用 PEERMEM 注册 GDR 显存，ib_write_bw 不添加 --use_maca_dmabuf。'
    : preferredMode === 'dmabuf'
      ? '当前使用 DMA-BUF 注册 GDR 显存，ib_write_bw 在命令末尾添加 --use_maca_dmabuf。'
      : dmaBufReady && !perftestDmaBufReady
        ? `DMA-BUF 链路就绪，但指定的 ${IB_WRITE_BW_PATH} 未确认支持 --use_maca_dmabuf。`
        : '当前没有已确认可用的 GDR 显存注册机制。';
  return { status, value, detail, activation, preferredMode, applicable:hasMetaxGpu && hasRdmaNic, driverConfigured, compatible, dmaBuf:{ ready:dmaBufReady, usableForIbWrite:dmaBufReady && perftestDmaBufReady, missing:missingDmaBuf, perftestPath:system.get('gdr_perftest_path') || '', evidence }, peerMem:{ ready:peerMemReady, property:evidence.peerMem, symbols:evidence.peerSymbols, ibRegAddr:evidence.ibRegAddr, ibUnregAddr:evidence.ibUnregAddr } };
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

function parseGpuNicTopo(text) {
  const rows = String(text || '').split(/\r?\n/).map((line) => line.trim().split(/\s+/)).filter((tokens) => tokens.length > 1);
  const header = rows.find((tokens) => tokens.some((token) => /^GPU\d+$/i.test(token)) && tokens.some((token) => /^NIC\d+$/i.test(token)));
  if (!header) return [];
  const nicNames = new Map();
  for (const match of String(text || '').matchAll(/^\s*(NIC\d+)\s*:\s*([^\s,]+)\s*$/gim)) nicNames.set(match[1].toUpperCase(), match[2]);
  const nicColumns = header.map((token, index) => ({ token:token.toUpperCase(), index })).filter(({ token }) => /^NIC\d+$/.test(token));
  const validDistances = new Set(['PIX', 'PXB', 'NODE', 'SYS']);
  const distances = [];
  for (const tokens of rows) {
    if (tokens === header) continue;
    const gpuMatch = /^GPU(\d+)$/i.exec(tokens[0]);
    if (!gpuMatch) continue;
    for (const column of nicColumns) {
      const code = String(tokens[column.index + 1] || '').toUpperCase();
      const nic = nicNames.get(column.token);
      if (nic && validDistances.has(code)) distances.push({ gpu:Number(gpuMatch[1]), nic, code });
    }
  }
  return distances;
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
  const containers = parseContainers(sections.SYSTEM);
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
    nodes: graphNodes, edges, containers,
    gpuLinks: parseTopo(sections.GPU_TOPO),
    gpuNicDistances: parseGpuNicTopo(sections.GPU_NIC_TOPO),
    summary: { cpus: nodes.length, gpus: relevant.filter((item) => item.type === 'gpu').length, nics: relevant.filter((item) => item.type === 'nic').length, switches: relevant.filter((item) => item.type === 'switch').length },
    compliance,
    diagnostics: { ibstat: sections.IB.trim(), gpuTopo: sections.GPU_TOPO.trim(), gpuNicTopo: sections.GPU_NIC_TOPO.trim(), macainfo: sections.MACA.trim(), ofed: sections.OFED.trim(), system: sections.SYSTEM.trim(), dmesg: sections.DMESG.trim(), pcieControls: sections.PCI_CTL.trim(), gids: sections.GIDS.trim(), roce: sections.ROCE.trim(), gpuHealth: sections.GPU_HEALTH.trim(), mxlk: sections.MXLK.trim(), gpuPcie: sections.GPU_PCIE.trim() }
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

function testGpuList(value, label, minimum = 1) {
  if (!Array.isArray(value) || value.length < minimum || value.length > 64) {
    throw new Error(`${label}需要选择 ${minimum} 到 64 张 GPU。`);
  }
  const gpus = value.map((entry) => Number(entry));
  if (gpus.some((gpu) => !Number.isInteger(gpu) || gpu < 0 || gpu > 63)) throw new Error('GPU 编号必须是 0 到 63 之间的整数。');
  if (new Set(gpus).size !== gpus.length) throw new Error('GPU 选择中不能包含重复编号。');
  return gpus;
}

function testNicList(value, { allowDuplicates = false } = {}) {
  if (!Array.isArray(value) || !value.length || value.length > 64) throw new Error('请选择 1 到 64 个 RDMA HCA。');
  const nics = value.map((entry) => String(entry || ''));
  if (nics.some((nic) => !/^[a-zA-Z0-9_.:-]{1,64}$/.test(nic))) throw new Error('RDMA HCA 名称格式无效。');
  if (!allowDuplicates && new Set(nics).size !== nics.length) throw new Error('RDMA HCA 选择中不能包含重复名称。');
  return nics;
}

function createTestRunId() {
  return randomBytes(12).toString('hex');
}

function validTestRunId(value) {
  const runId = String(value || '');
  if (!/^[a-f0-9]{24}$/.test(runId)) throw new Error('测试运行标识格式无效。');
  return runId;
}

function testRecipe(payload, requestedRunId = createTestRunId()) {
  const runId = validTestRunId(requestedRunId);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('测试请求格式无效。');
  const testId = String(payload.testId || '');
  if (!TEST_LABELS.has(testId)) throw new Error('不支持该测试项。');
  if (payload.confirmed !== true) throw new Error('请先确认 GPU 空闲并接受性能测试影响。');
  const params = payload.params && typeof payload.params === 'object' && !Array.isArray(payload.params) ? payload.params : {};
  const gpuA = Number(params.gpuA);
  const gpuB = Number(params.gpuB);
  const gpuCount = Number(params.gpuCount ?? 2);
  const gidIndex = Number(params.gidIndex ?? 3);
  const nic = String(params.nic || '');
  const nicA = String(params.nicA || '');
  const nicB = String(params.nicB || '');
  const transport = String(params.transport ?? 'RoCE');
  const gdrMode = String(params.gdrMode || 'auto').toLowerCase();
  const containerRuntime = String(params.containerRuntime || '');
  const containerId = String(params.containerId || '');
  const imageRuntime = String(params.imageRuntime || '');
  const imageId = String(params.imageId || '');
  if (!Number.isInteger(gpuCount) || gpuCount < 1 || gpuCount > 64) throw new Error('GPU 数量必须在 1 到 64 之间。');
  if (!Number.isInteger(gidIndex) || gidIndex < 0 || gidIndex > 255) throw new Error('GID Index 必须在 0 到 255 之间。');
  if (!['IB', 'RoCE'].includes(transport)) throw new Error('网络类型只支持 InfiniBand 或 RoCE。');
  if (!['auto', 'dmabuf', 'peermem'].includes(gdrMode)) throw new Error('GDR 显存注册方式无效。');
  if ([nic, nicA, nicB].some((value) => value && !/^[a-zA-Z0-9_.:-]{1,64}$/.test(value))) throw new Error('RDMA HCA 名称格式无效。');
  if (Boolean(containerRuntime) !== Boolean(containerId)) throw new Error('容器运行时和容器 ID 必须同时提供。');
  if (Boolean(imageRuntime) !== Boolean(imageId)) throw new Error('镜像运行时和镜像 ID 必须同时提供。');
  if (containerId && imageId) throw new Error('运行中的容器和本地镜像不能同时选择。');
  if (containerRuntime && !['docker', 'podman', 'nerdctl'].includes(containerRuntime)) throw new Error('不支持该容器运行时。');
  if (containerId && !/^[a-f0-9]{12,64}$/i.test(containerId)) throw new Error('容器 ID 格式无效。');
  if (imageRuntime && !['docker', 'podman', 'nerdctl'].includes(imageRuntime)) throw new Error('不支持该镜像运行时。');
  if (imageId && !/^(?:sha256:)?[a-f0-9]{12,64}$/i.test(imageId)) throw new Error('镜像 ID 格式无效。');
  let gpus = [];
  let nics = [];
  if (testId === 'gpu-vector-add') {
    const requestedGpus = Array.isArray(params.gpus) ? params.gpus : [params.gpu ?? 0];
    gpus = testGpuList(requestedGpus, 'vectorAdd');
  } else if (testId === 'nic-p2p') {
    if (!Number.isInteger(gpuA) || !Number.isInteger(gpuB)) throw new Error('请为 P2P 两端分别选择 GPU。');
    if (gpuA === gpuB) throw new Error('P2P 两端必须选择不同 GPU。');
    if (!nicA || !nicB) throw new Error('请为 P2P 两端分别选择 RDMA HCA。');
    gpus = testGpuList([gpuA, gpuB], 'P2P', 2);
    nics = testNicList([nicA, nicB], { allowDuplicates:true });
  } else if (testId === 'nic-alltoall') {
    gpus = testGpuList(params.gpus, 'alltoall', 2);
    nics = testNicList(params.nics);
  }
  const nicTests = new Set(['host-ibrc', 'host-ibgda']);
  const multiGpuTests = new Set(['host-ibrc', 'host-ibgda']);
  if (nicTests.has(testId) && !nic) throw new Error('该测试需要选择 RDMA HCA。');
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
  const allGpuPreflight = [
    'busy_gpu="$( { mx-smi -s 2>/dev/null || /opt/maca/bin/mx-smi -s 2>/dev/null || true; } | awk \'/^[[:space:]]*GPU[[:space:]]*:/ { value=$3; gsub(/%/, "", value); if ((value + 0) > 5) { print value; exit } }\')"',
    'if [ -n "$busy_gpu" ]; then printf "检测到 GPU 使用率 %s%%，为避免影响现有任务已拒绝启动。\\n" "$busy_gpu" >&2; exit 3; fi'
  ];
  let lines = [...common];
  let preview = '';
  let timeoutMs = 180_000;
  if (testId.startsWith('host-')) lines.push(...allGpuPreflight);
  if (testId === 'nic-p2p' || testId === 'nic-alltoall') {
    const selectedGpuCsv = gpus.join(',');
    lines.push(
      `busy_gpu="$( { mx-smi -s 2>/dev/null || /opt/maca/bin/mx-smi -s 2>/dev/null || true; } | awk -v wanted=',${selectedGpuCsv},' '/^GPU#[0-9]+[[:space:]]/ { gpu=$1; sub(/^GPU#/, "", gpu); selected=index(wanted, "," gpu ",") > 0 } /^[[:space:]]*GPU[[:space:]]*:/ && selected { value=$3; gsub(/%/, "", value); if ((value + 0) > 5) { printf "GPU %s: %s%%", gpu, value; exit } }')"`,
      'if [ -n "$busy_gpu" ]; then printf "检测到所选 %s 使用率超过 5%%，为避免影响现有任务已拒绝启动。\\n" "$busy_gpu" >&2; exit 3; fi'
    );
  }

  if (testId === 'gpu-vector-add') {
    timeoutMs = Math.min(300_000, 80_000 + gpus.length * 10_000);
    preview = `for gpu in ${gpus.join(' ')}; do MACA_VISIBLE_DEVICES=$gpu vectorAdd; done`;
    const selectedGpuCsv = gpus.join(',');
    lines.push(
      `selected_gpus=${shellSingleQuote(gpus.join(' '))}`,
      `selected_gpu_count=${gpus.length}`,
      `busy_gpu="$( { mx-smi -s 2>/dev/null || /opt/maca/bin/mx-smi -s 2>/dev/null || true; } | awk -v wanted=',${selectedGpuCsv},' '/^GPU#[0-9]+[[:space:]]/ { gpu=$1; sub(/^GPU#/, "", gpu); selected=index(wanted, "," gpu ",") > 0 } /^[[:space:]]*GPU[[:space:]]*:/ && selected { value=$3; gsub(/%/, "", value); if ((value + 0) > 5) { printf "GPU %s: %s%%", gpu, value; exit } }')"`,
      'if [ -n "$busy_gpu" ]; then printf "检测到所选 %s 使用率超过 5%%，为避免影响现有任务已拒绝启动。\\n" "$busy_gpu" >&2; exit 3; fi',
      'sample_dir=/opt/maca/samples/0_Introduction/vectorAdd',
      'compiler=/opt/maca/mxgpu_llvm/bin/mxcc',
      '[ -r "$sample_dir/vectorAdd.cpp" ] || { echo "未安装 vectorAdd 示例源码。" >&2; exit 127; }',
      '[ -x "$compiler" ] || { echo "未安装 mxcc 编译器。" >&2; exit 127; }',
      'work_dir="$(mktemp -d)"',
      'trap \'rm -rf "$work_dir"\' EXIT',
      '"$compiler" -x maca -offload-arch native "$sample_dir/vectorAdd.cpp" -o "$work_dir/vectorAdd" --maca-path=/opt/maca',
      'vector_failures=0',
      'for gpu_index in $selected_gpus; do',
      '  printf "\\n--- GPU %s vectorAdd ---\\n" "$gpu_index"',
      '  if MACA_VISIBLE_DEVICES="$gpu_index" "$work_dir/vectorAdd"; then',
      '    printf "[GPU %s] 通过\\n" "$gpu_index"',
      '  else',
      '    gpu_exit=$?',
      '    printf "[GPU %s] 失败（退出码 %s）\\n" "$gpu_index" "$gpu_exit" >&2',
      '    vector_failures=$((vector_failures + 1))',
      '  fi',
      'done',
      'if [ "$vector_failures" -ne 0 ]; then printf "vectorAdd 汇总：%s/%s 张 GPU 失败。\\n" "$vector_failures" "$selected_gpu_count" >&2; exit 1; fi',
      'printf "vectorAdd 汇总：所选 GPU（%s）全部通过。\\n" "${selected_gpus// /,}"'
    );
  } else if (testId === 'nic-p2p') {
    const gidOption = transport === 'RoCE' ? ` -x ${gidIndex}` : '';
    const mxrdmaOptions = nics.some((name) => name.startsWith('metax_rdma_')) ? ' --disable_pcie_relaxed --use_old_post_send -n 10 -m 4096' : ' -F --report_gbits';
    const p2pPort = 20_000 + (Number.parseInt(runId.slice(0, 4), 16) % 20_000);
    const gdrPreviewOption = gdrMode === 'dmabuf' ? ' --use_maca_dmabuf' : '';
    const gdrPreviewLabel = gdrMode === 'dmabuf'
      ? 'DMA-BUF（追加 --use_maca_dmabuf）'
      : gdrMode === 'peermem' ? 'PEERMEM（不追加 --use_maca_dmabuf）' : '运行时自动检测 DMA-BUF / PEERMEM';
    preview = `GDR: ${gdrPreviewLabel}\nserver: ${IB_WRITE_BW_PATH} -a${mxrdmaOptions} -d ${nics[0]} --use_maca=${gpus[0]}${gidOption} -p ${p2pPort}${gdrPreviewOption} &\nclient: ${IB_WRITE_BW_PATH} -a${mxrdmaOptions} -d ${nics[1]} --use_maca=${gpus[1]}${gidOption} -p ${p2pPort} localhost${gdrPreviewOption}`;
    lines.push(
      `ib_write=${shellSingleQuote(IB_WRITE_BW_PATH)}`,
      '[ -x "$ib_write" ] || { printf "缺少测试程序：%s\\n" "$ib_write" >&2; exit 127; }',
      `p2p_gdr_hint=${shellSingleQuote(gdrMode)}`,
      'p2p_peer_mem=unknown',
      'for p2p_properties in /sys/class/mxcd/mxcd/layout/properties /sys/class/metax/mxcd/layout/properties; do',
      '  [ -r "$p2p_properties" ] || continue',
      "  p2p_peer_value=\"$(awk '$1 == \"peer_mem\" { print $2; exit }' \"$p2p_properties\")\"",
      '  if [ "$p2p_peer_value" = 0 ] || [ "$p2p_peer_value" = 1 ]; then p2p_peer_mem=$p2p_peer_value; break; fi',
      'done',
      'p2p_kmd_dmabuf=unknown',
      'p2p_metax_info="$(modinfo metax 2>/dev/null || true)"',
      'if [ -n "$p2p_metax_info" ]; then',
      '  if printf "%s\\n" "$p2p_metax_info" | grep -Eq "^import_ns:.*DMA_BUF"; then',
      '    p2p_kmd_dmabuf=yes',
      '  elif command -v strings >/dev/null 2>&1; then',
      "    p2p_metax_module=\"$(printf '%s\\n' \"$p2p_metax_info\" | awk '/^filename:/{print $2; exit}')\"",
      '    if [ -r "$p2p_metax_module" ]; then',
      "      if strings \"$p2p_metax_module\" 2>/dev/null | grep -Eq '^dma_buf_(fd|get|put)$'; then p2p_kmd_dmabuf=yes; else p2p_kmd_dmabuf=no; fi",
      '    fi',
      '  fi',
      'fi',
      'p2p_kernel_dmabuf=unknown',
      'p2p_rdma_dmabuf=unknown',
      'p2p_peer_symbols=unknown',
      'if [ -r /proc/kallsyms ]; then',
      '  if grep -qw dma_buf_export /proc/kallsyms 2>/dev/null; then p2p_kernel_dmabuf=yes; else p2p_kernel_dmabuf=no; fi',
      "  if grep -Eq '[[:space:]]ib_umem_dmabuf_get(_pinned)?([[:space:]]|$)' /proc/kallsyms 2>/dev/null; then p2p_rdma_dmabuf=yes; else p2p_rdma_dmabuf=no; fi",
      '  if grep -qw ib_register_peer_memory_client /proc/kallsyms 2>/dev/null && grep -qw ib_unregister_peer_memory_client /proc/kallsyms 2>/dev/null; then p2p_peer_symbols=yes; else p2p_peer_symbols=no; fi',
      'fi',
      'p2p_ibverbs_dmabuf=unknown',
      "p2p_ibverbs_path=\"$(ldconfig -p 2>/dev/null | awk '/libibverbs\\.so\\.1/{print $NF; exit}')\"",
      'if [ -n "$p2p_ibverbs_path" ] && [ -r "$p2p_ibverbs_path" ]; then',
      '  if command -v nm >/dev/null 2>&1; then',
      '    if nm -D "$p2p_ibverbs_path" 2>/dev/null | grep -qw ibv_reg_dmabuf_mr; then p2p_ibverbs_dmabuf=yes; else p2p_ibverbs_dmabuf=no; fi',
      '  elif command -v strings >/dev/null 2>&1; then',
      '    if strings "$p2p_ibverbs_path" 2>/dev/null | grep -qw ibv_reg_dmabuf_mr; then p2p_ibverbs_dmabuf=yes; else p2p_ibverbs_dmabuf=no; fi',
      '  fi',
      'fi',
      'if "$ib_write" --help 2>&1 | grep -q -- "--use_maca_dmabuf"; then p2p_perftest_dmabuf=yes; else p2p_perftest_dmabuf=no; fi',
      'p2p_gdr_mode=',
      'if [ "$p2p_peer_mem" = 1 ]; then',
      '  p2p_gdr_mode=peermem',
      'elif [ "$p2p_peer_mem" = 0 ]; then',
      '  p2p_gdr_mode=dmabuf',
      'elif [ "$p2p_gdr_hint" = dmabuf ] || [ "$p2p_gdr_hint" = peermem ]; then',
      '  p2p_gdr_mode=$p2p_gdr_hint',
      'elif [ "$p2p_kmd_dmabuf" = yes ] && [ "$p2p_kernel_dmabuf" = yes ] && [ "$p2p_rdma_dmabuf" = yes ] && [ "$p2p_ibverbs_dmabuf" = yes ] && [ "$p2p_perftest_dmabuf" = yes ]; then',
      '  p2p_gdr_mode=dmabuf',
      'elif [ "$p2p_peer_symbols" = yes ]; then',
      '  p2p_gdr_mode=peermem',
      'fi',
      'if [ -z "$p2p_gdr_mode" ]; then',
      '  printf "无法判定 GDR 显存注册方式（peer_mem=%s，KMD/内核/RDMA/libibverbs/perftest DMA-BUF=%s/%s/%s/%s/%s）。请先重新采集环境。\\n" "$p2p_peer_mem" "$p2p_kmd_dmabuf" "$p2p_kernel_dmabuf" "$p2p_rdma_dmabuf" "$p2p_ibverbs_dmabuf" "$p2p_perftest_dmabuf" >&2',
      '  exit 2',
      'fi',
      'p2p_memory_args=()',
      'if [ "$p2p_gdr_mode" = dmabuf ]; then',
      '  if [ "$p2p_perftest_dmabuf" != yes ]; then printf "当前 ib_write_bw 不支持 --use_maca_dmabuf，无法使用 DMA-BUF。\\n" >&2; exit 2; fi',
      '  if [ "$p2p_kmd_dmabuf" = no ] || [ "$p2p_kernel_dmabuf" = no ] || [ "$p2p_rdma_dmabuf" = no ] || [ "$p2p_ibverbs_dmabuf" = no ]; then',
      '    printf "DMA-BUF 链路不完整（KMD/内核/RDMA/libibverbs=%s/%s/%s/%s）。\\n" "$p2p_kmd_dmabuf" "$p2p_kernel_dmabuf" "$p2p_rdma_dmabuf" "$p2p_ibverbs_dmabuf" >&2',
      '    exit 2',
      '  fi',
      '  p2p_memory_args=(--use_maca_dmabuf)',
      '  printf "GDR 显存注册方式：DMA-BUF（peer_mem=%s），命令末尾追加 --use_maca_dmabuf。\\n" "$p2p_peer_mem"',
      'else',
      '  printf "GDR 显存注册方式：PEERMEM（peer_mem=%s），不添加 --use_maca_dmabuf。\\n" "$p2p_peer_mem"',
      'fi',
      `p2p_port=${p2pPort}`,
      'p2p_server_log="$(mktemp)"',
      'p2p_server_pid=',
      'p2p_stop_server() {',
      '  [ -n "$p2p_server_pid" ] || return 0',
      '  if kill -0 "$p2p_server_pid" 2>/dev/null; then',
      '    kill -TERM "$p2p_server_pid" 2>/dev/null || true',
      '    p2p_wait=0',
      '    while kill -0 "$p2p_server_pid" 2>/dev/null && [ "$p2p_wait" -lt 15 ]; do sleep 0.1; p2p_wait=$((p2p_wait + 1)); done',
      '    if kill -0 "$p2p_server_pid" 2>/dev/null; then kill -KILL "$p2p_server_pid" 2>/dev/null || true; fi',
      '  fi',
      '}',
      'p2p_cleanup() {',
      '  trap - EXIT HUP INT TERM',
      '  p2p_stop_server',
      '  [ -z "$p2p_server_pid" ] || wait "$p2p_server_pid" 2>/dev/null || true',
      '  rm -f "$p2p_server_log"',
      '}',
      "trap 'p2p_cleanup' EXIT",
      "trap 'p2p_cleanup; exit 143' HUP INT TERM",
      `printf '启动本机 P2P 服务端：GPU ${gpus[0]} ↔ ${nics[0]}，端口 %s\\n' "$p2p_port"`,
      `"$ib_write" -a${mxrdmaOptions} -d ${nics[0]} --use_maca=${gpus[0]}${gidOption} -p "$p2p_port" "\${p2p_memory_args[@]}" >"$p2p_server_log" 2>&1 &`,
      'p2p_server_pid=$!',
      'sleep 1',
      'if ! kill -0 "$p2p_server_pid" 2>/dev/null; then',
      '  set +e; wait "$p2p_server_pid"; p2p_server_status=$?; set -e',
      '  [ "$p2p_server_status" -ne 0 ] || p2p_server_status=1',
      "  printf '%s\\n' '--- P2P 服务端日志 ---'; cat \"$p2p_server_log\"",
      '  printf "P2P 服务端启动失败（退出码 %s）。\\n" "$p2p_server_status" >&2',
      '  exit "$p2p_server_status"',
      'fi',
      `printf '启动本机 P2P 客户端：GPU ${gpus[1]} ↔ ${nics[1]}，连接 localhost:%s\\n' "$p2p_port"`,
      'set +e',
      `"$ib_write" -a${mxrdmaOptions} -d ${nics[1]} --use_maca=${gpus[1]}${gidOption} -p "$p2p_port" localhost "\${p2p_memory_args[@]}"`,
      'p2p_client_status=$?',
      'if [ "$p2p_client_status" -ne 0 ]; then p2p_stop_server; fi',
      'wait "$p2p_server_pid"',
      'p2p_server_status=$?',
      'set -e',
      "printf '%s\\n' '--- P2P 服务端日志 ---'; cat \"$p2p_server_log\"",
      'p2p_server_pid=',
      'rm -f "$p2p_server_log"',
      'trap - EXIT HUP INT TERM',
      'if [ "$p2p_client_status" -ne 0 ] || [ "$p2p_server_status" -ne 0 ]; then',
      '  printf "P2P 测试失败：server=%s, client=%s。\\n" "$p2p_server_status" "$p2p_client_status" >&2',
      '  exit 1',
      'fi',
      'printf "P2P localhost 双端测试通过。\\n"'
    );
  } else if (testId === 'nic-alltoall') {
    timeoutMs = 300_000;
    const selectedGpuCsv = gpus.join(',');
    const selectedNicCsv = nics.join(',');
    const gidEnvironment = transport === 'RoCE' ? ` MCCL_IB_GID_INDEX=${gidIndex}` : '';
    preview = `MACA_VISIBLE_DEVICES=${selectedGpuCsv} MCCL_IB_HCA=${selectedNicCsv}${gidEnvironment} MCCL_IB_DISABLE=0 MCCL_NET_DISABLE_INTRA=0 MCCL_P2P_LEVEL=LOC MCCL_SHM_DISABLE=1 ${MACA_MPIRUN_PATH} -n ${gpus.length} ${MCCL_ALLTOALL_PATH}`;
    lines.push(
      `mpi=${shellSingleQuote(MACA_MPIRUN_PATH)}`,
      `perf=${shellSingleQuote(MCCL_ALLTOALL_PATH)}`,
      '[ -x "$mpi" ] || { printf "缺少测试程序：%s\\n" "$mpi" >&2; exit 127; }',
      '[ -x "$perf" ] || { printf "缺少测试程序：%s\\n" "$perf" >&2; exit 127; }',
      `export MACA_VISIBLE_DEVICES=${selectedGpuCsv} MCCL_IB_HCA=${selectedNicCsv}`,
      transport === 'RoCE' ? `export MCCL_IB_GID_INDEX=${gidIndex}` : 'unset MCCL_IB_GID_INDEX',
      'export MCCL_IB_DISABLE=0 MCCL_NET_DISABLE_INTRA=0 MCCL_P2P_LEVEL=LOC MCCL_SHM_DISABLE=1',
      'unset MCCL_NET_GDR_LEVEL',
      'if [ "$(id -u)" -eq 0 ]; then export OMPI_ALLOW_RUN_AS_ROOT=1 OMPI_ALLOW_RUN_AS_ROOT_CONFIRM=1; fi',
      'printf "通信通路：RDMA HCA（IB/RoCE）；已禁用 PCIe/MetaXLink P2P 与 SHM。\\n"',
      `exec "$mpi" -n ${gpus.length} "$perf"`
    );
  } else if (testId === 'host-ibrc') {
    timeoutMs = 300_000;
    preview = `MCCL_P2P_LEVEL=LOC MCCL_IB_HCA=${nic} mpirun -n ${gpuCount} alltoall_perf`;
    lines.push(
      'mpi="$(first_exec /opt/maca/ompi/bin/mpirun /usr/bin/mpirun)"',
      'perf="$(first_exec /opt/maca/tools/communication/mccl/mccl_perf/alltoall_perf /opt/maca/samples/mccl_tests/perf/mccl_perf/alltoall_perf)"',
      `export MCCL_IB_HCA=${nic} MCCL_P2P_LEVEL=LOC MCCL_SHM_DISABLE=1 MCCL_NET_GDR_LEVEL=SYS`,
      `exec "$mpi" --allow-run-as-root -n ${gpuCount} -mca pml ^ucx -mca osc ^ucx -mca btl ^openib -x METAX_INSPECTION_RUN_ID -x LD_LIBRARY_PATH -x MCCL_IB_HCA -x MCCL_P2P_LEVEL -x MCCL_SHM_DISABLE -x MCCL_NET_GDR_LEVEL "$perf" -b 1M -e 256M -f 2 -g 1 -n 5`
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
  preview = `${MACA_LIBRARY_PATH_PREVIEW}\n${preview}`;
  let script = `${lines.join('\n')}\n`;
  let execution = { kind:'host' };
  if (containerRuntime && containerId) {
    execution = { kind:'container', runtime:containerRuntime, id:containerId.toLowerCase() };
    script = [
      'set -e',
      `container_runtime=${shellSingleQuote(execution.runtime)}`,
      `container_id=${shellSingleQuote(execution.id)}`,
      'command -v "$container_runtime" >/dev/null 2>&1 || { printf "未安装容器运行时：%s\\n" "$container_runtime" >&2; exit 127; }',
      'container_state="$("$container_runtime" inspect -f \'{{.State.Running}}\' "$container_id" 2>/dev/null || true)"',
      '[ "$container_state" = "true" ] || { printf "容器不存在、未运行或当前用户无访问权限：%s\\n" "$container_id" >&2; exit 4; }',
      'printf "运行环境：%s 容器 %s\\n" "$container_runtime" "$container_id"',
      'exec "$container_runtime" exec -i -e "METAX_INSPECTION_RUN_ID=$METAX_INSPECTION_RUN_ID" "$container_id" bash -s <<\'__METAX_CONTAINER_TEST__\'',
      script.trimEnd(),
      '__METAX_CONTAINER_TEST__'
    ].join('\n') + '\n';
    preview = `${execution.runtime} exec -i ${execution.id.slice(0, 12)} bash -s · ${preview}`;
  } else if (imageRuntime && imageId) {
    const containerName = `metax-test-${testId}-${runId}`;
    execution = { kind:'image', runtime:imageRuntime, id:imageId.toLowerCase(), containerName };
    script = [
      'set -e',
      `image_runtime=${shellSingleQuote(execution.runtime)}`,
      `image_id=${shellSingleQuote(execution.id)}`,
      'command -v "$image_runtime" >/dev/null 2>&1 || { printf "未安装容器运行时：%s\\n" "$image_runtime" >&2; exit 127; }',
      '"$image_runtime" image inspect "$image_id" >/dev/null 2>&1 || { printf "本地镜像不存在或当前用户无访问权限：%s\\n" "$image_id" >&2; exit 4; }',
      `test_container_name=${shellSingleQuote(containerName)}`,
      'run_args=(run --rm -i --name "$test_container_name" --env "METAX_INSPECTION_RUN_ID=$METAX_INSPECTION_RUN_ID" --network=host --uts=host --ipc=host --privileged=true --security-opt seccomp=unconfined --security-opt apparmor=unconfined --shm-size=100gb --ulimit memlock=-1)',
      'for device in /dev/dri /dev/mxcd /dev/infiniband; do if [ -e "$device" ]; then run_args+=(--device="$device"); else printf "提示：宿主机未发现 %s，已跳过映射。\\n" "$device"; fi; done',
      'video_gid="$(getent group video 2>/dev/null | cut -d: -f3)"',
      '[ -z "$video_gid" ] || run_args+=(--group-add "$video_gid")',
      'printf "运行环境：由本地镜像 %s 启动临时容器 %s（测试结束自动删除）\\n" "$image_id" "$test_container_name"',
      'exec "$image_runtime" "${run_args[@]}" "$image_id" bash -s <<\'__METAX_IMAGE_TEST__\'',
      script.trimEnd(),
      '__METAX_IMAGE_TEST__'
    ].join('\n') + '\n';
    preview = `${execution.runtime} run --rm -i [GPU/RDMA/host namespaces/privileged] ${execution.id.slice(0, 19)} bash -s · ${preview}`;
  }
  return { testId, label: TEST_LABELS.get(testId), script, preview, timeoutMs, execution, runId };
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

function singleEpCaseRecipe(config, testCase, runtimeTestDir = SINGLE_EP_TEST_DIR) {
  const program = SINGLE_EP_RUNTIME_PROGRAMS[config.testType];
  if (!program) throw new Error('不支持该 SingleEP 测试类型。');
  const launcher = program.launcher;
  let args;
  if (config.testType === 'low-latency') {
    args = [
      String(testCase.rank), '--', '--num-tokens', String(testCase.tokens),
      '--hidden', String(testCase.hidden), '--warmup', '20', '--tests', '30'
    ];
  } else if (config.testType === 'intranode') {
    args = [
      String(testCase.rank), '--', '--num-tokens', String(testCase.tokens),
      '--hidden', String(testCase.hidden)
    ];
  } else {
    args = ['--', '--num-tokens', String(testCase.tokens), '--hidden', String(testCase.hidden)];
  }
  const testDir = path.resolve(runtimeTestDir);
  const testRoot = path.dirname(testDir);
  const printableArgs = args.join(' ');
  const preview = MACA_LIBRARY_PATH_PREVIEW + '\n' + 'bash ' + testDir + '/' + launcher + ' ' + printableArgs;
  const lines = [
    'set -e',
    'export LC_ALL=C',
    'test_dir=' + shellSingleQuote(testDir),
    'test_root=' + shellSingleQuote(testRoot),
    'export LD_LIBRARY_PATH="/opt/maca/lib:$test_root:${LD_LIBRARY_PATH:-}"',
    '[ -r "$test_dir/' + launcher + '" ] || { printf "SingleEP 启动器不存在或不可读：%s\\n" "$test_dir/' + launcher + '" >&2; exit 127; }',
    '[ -x "$test_dir/' + program.executable + '" ] || { printf "SingleEP 测试程序不存在或不可执行：%s\\n" "$test_dir/' + program.executable + '" >&2; exit 127; }',
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

function singleEpRuntimeBundle(config, requestedRunId) {
  const runId = validTestRunId(requestedRunId);
  const program = SINGLE_EP_RUNTIME_PROGRAMS[config.testType];
  if (!program) throw new Error('不支持该 SingleEP 测试类型。');
  const sourceRoot = path.dirname(path.resolve(SINGLE_EP_TEST_DIR));
  const assets = [
    'singleep.so',
    'third_party/mxshmem/lib/libmxshmem_host.so',
    `test/${program.launcher}`,
    `test/${program.executable}`
  ];
  for (const asset of assets) {
    const source = path.join(sourceRoot, asset);
    try { fs.accessSync(source, fs.constants.R_OK); }
    catch { throw new Error(`巡检平台缺少 SingleEP 运行文件：${source}`); }
  }
  const stageDir = `/tmp/metax-singleep-${runId}`;
  const uploadDir = `${stageDir}.upload`;
  const remoteScript = [
    'set -e',
    'umask 077',
    `stage_dir=${shellSingleQuote(stageDir)}`,
    `upload_dir=${shellSingleQuote(uploadDir)}`,
    'cleanup_upload() { rm -rf -- "$upload_dir"; }',
    "trap 'cleanup_upload' EXIT HUP INT TERM",
    'rm -rf -- "$upload_dir"',
    'mkdir -p -- "$upload_dir"',
    'tar -xzf - -C "$upload_dir"',
    `[ -r "$upload_dir/singleep.so" ] || { echo "SingleEP 运行包缺少 singleep.so。" >&2; exit 127; }`,
    `[ -r "$upload_dir/third_party/mxshmem/lib/libmxshmem_host.so" ] || { echo "SingleEP 运行包缺少 libmxshmem_host.so。" >&2; exit 127; }`,
    `[ -r "$upload_dir/test/${program.launcher}" ] || { echo "SingleEP 运行包缺少 ${program.launcher}。" >&2; exit 127; }`,
    `[ -x "$upload_dir/test/${program.executable}" ] || { echo "SingleEP 运行包缺少可执行文件 ${program.executable}。" >&2; exit 127; }`,
    'rm -rf -- "$stage_dir"',
    'mv -- "$upload_dir" "$stage_dir"',
    'trap - EXIT HUP INT TERM'
  ].join('\n');
  return { sourceRoot, assets, stageDir, testDir:`${stageDir}/test`, remoteScript };
}

function prepareSingleEpRuntime(config, target, batch, res) {
  const normalized = normalizeTestTarget(target);
  if (normalized.kind !== 'remote') return Promise.resolve({ ready:true, testDir:path.resolve(SINGLE_EP_TEST_DIR), stageDir:'' });
  const bundle = singleEpRuntimeBundle(config, batch.runId);
  batch.runtimeStageDir = bundle.stageDir;
  sendStreamEvent(res, {
    type:'output', stream:'stdout',
    text:`[准备] 正在将 SingleEP ${config.typeLabel} 运行包传输到远端临时目录 ${bundle.stageDir}…\n`
  });
  return new Promise((resolve, reject) => {
    const launch = remoteSshCommandLaunch(normalized, `bash -c ${shellSingleQuote(bundle.remoteScript)}`);
    let remote;
    let archive;
    try {
      remote = spawn(launch.command, launch.args, {
        detached:true,
        stdio:launch.fdPassword ? ['pipe', 'pipe', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe']
      });
      archive = spawn('tar', ['-C', bundle.sourceRoot, '-czf', '-', ...bundle.assets], {
        detached:true,
        stdio:['ignore', 'pipe', 'pipe']
      });
    } catch (error) {
      terminateProcessGroup(remote);
      terminateProcessGroup(archive);
      return reject(error);
    }
    batch.child = remote;
    let remoteDone = false;
    let archiveDone = false;
    let remoteCode = null;
    let archiveCode = null;
    let remoteSignal = null;
    let archiveSignal = null;
    let remoteError = '';
    let archiveError = '';
    let terminalError = null;
    let settled = false;
    let timeout;
    let stopPromise = null;
    const appendLimited = (current, chunk) => current.length >= 65_536
      ? current
      : (current + chunk.toString('utf8')).slice(0, 65_536);
    const stageError = () => {
      const detail = [archiveError.trim(), remoteError.trim()].filter(Boolean).join('；');
      if (terminalError) return detail ? `${terminalError.message}：${detail}` : terminalError.message;
      if (archiveCode !== 0) return `生成 SingleEP 运行包失败（退出码 ${archiveCode ?? archiveSignal ?? '未知'}）${detail ? `：${detail}` : ''}`;
      return `传输 SingleEP 运行包失败（退出码 ${remoteCode ?? remoteSignal ?? '未知'}）${detail ? `：${detail}` : ''}`;
    };
    const finish = (forced = false) => {
      if (settled || (!forced && (!remoteDone || !archiveDone))) return;
      settled = true;
      clearTimeout(timeout);
      if (batch.child === remote) batch.child = null;
      if (batch.stopCurrent === stopStage) batch.stopCurrent = null;
      const success = !terminalError && remoteCode === 0 && archiveCode === 0;
      if (success) {
        sendStreamEvent(res, { type:'output', stream:'stdout', text:`[准备] SingleEP 运行包已就绪。\n` });
        resolve({ ready:true, testDir:bundle.testDir, stageDir:bundle.stageDir });
      } else if (batch.cancelled) {
        resolve({ ready:false, testDir:bundle.testDir, stageDir:bundle.stageDir });
      } else {
        reject(new Error(stageError()));
      }
    };
    function stopStage(message = 'SingleEP 运行包传输已停止。') {
      if (stopPromise) return stopPromise;
      if (!terminalError) terminalError = new Error(message);
      stopPromise = (async () => {
        terminateProcessGroup(archive);
        terminateProcessGroup(remote);
        let [archiveExited, remoteExited] = await Promise.all([
          waitForProcessClose(archive, TEST_STOP_GRACE_MS),
          waitForProcessClose(remote, TEST_STOP_GRACE_MS)
        ]);
        if (!archiveExited) terminateProcessGroup(archive, 'SIGKILL');
        if (!remoteExited) terminateProcessGroup(remote, 'SIGKILL');
        if (!archiveExited || !remoteExited) {
          [archiveExited, remoteExited] = await Promise.all([
            waitForProcessClose(archive, 2_000),
            waitForProcessClose(remote, 2_000)
          ]);
        }
        if (archiveExited) {
          archiveDone = true;
          archiveCode ??= archive.exitCode;
          archiveSignal ??= archive.signalCode;
        }
        if (remoteExited) {
          remoteDone = true;
          remoteCode ??= remote.exitCode;
          remoteSignal ??= remote.signalCode;
        }
        // close 通常会自然触发 finish；这里强制收口，避免异常子进程只报 error/exit 时批次一直等待。
        finish(true);
        return {
          confirmed:archiveExited && remoteExited,
          error:archiveExited && remoteExited ? '' : '无法确认 SingleEP 运行包传输进程已完全退出。'
        };
      })();
      return stopPromise;
    }
    batch.stopCurrent = stopStage;
    remote.stdout.on('data', () => {});
    remote.stderr.on('data', (chunk) => { remoteError = appendLimited(remoteError, chunk); });
    archive.stderr.on('data', (chunk) => { archiveError = appendLimited(archiveError, chunk); });
    remote.stdin.on('error', (error) => { if (!settled) void stopStage(error.message); });
    archive.stdout.on('error', (error) => { if (!settled) void stopStage(error.message); });
    remote.on('error', (error) => {
      if (!terminalError) terminalError = error;
      void stopStage(error.message);
    });
    archive.on('error', (error) => {
      if (!terminalError) terminalError = error;
      void stopStage(error.message);
    });
    remote.on('close', (code, signal) => {
      remoteDone = true;
      remoteCode = code;
      remoteSignal = signal;
      if (code !== 0) terminateProcessGroup(archive);
      finish();
    });
    archive.on('close', (code, signal) => {
      archiveDone = true;
      archiveCode = code;
      archiveSignal = signal;
      if (code !== 0) terminateProcessGroup(remote);
      finish();
    });
    if (launch.fdPassword) {
      remote.stdio[3].on('error', () => {});
      remote.stdio[3].end(`${launch.fdPassword}\n`);
    }
    archive.stdout.pipe(remote.stdin);
    timeout = setTimeout(() => { void stopStage(`SingleEP 运行包传输超过 ${SINGLE_EP_STAGE_TIMEOUT_MS / 1000} 秒，已停止。`); }, SINGLE_EP_STAGE_TIMEOUT_MS);
    timeout.unref?.();
  });
}

function runTargetMaintenanceScript(target, script, timeoutMs = TEST_CLEANUP_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let launch;
    try { launch = rawTestLaunch(target, script); }
    catch (error) { return resolve({ success:false, error:errorMessage(error) }); }
    const hasPasswordFd = Boolean(launch.fdPassword);
    let child;
    try {
      child = spawn(launch.command, launch.args, {
        detached:true,
        stdio:hasPasswordFd ? ['pipe', 'ignore', 'pipe', 'pipe'] : ['pipe', 'ignore', 'pipe']
      });
    } catch (error) {
      return resolve({ success:false, error:errorMessage(error) });
    }
    let settled = false;
    let stderr = '';
    let timeout;
    let forceTimer;
    const finish = (success, error = '') => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(forceTimer);
      resolve({ success, error:error || stderr.trim() });
    };
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString('utf8')).slice(0, 32_768); });
    child.stdin.on('error', () => {});
    child.on('error', (error) => finish(false, error.message));
    child.on('close', (code, signal) => finish(code === 0, code === 0 ? '' : `退出码 ${code ?? signal ?? '未知'}`));
    if (hasPasswordFd) {
      child.stdio[3].on('error', () => {});
      child.stdio[3].end(`${launch.fdPassword}\n`);
    }
    child.stdin.end(launch.input);
    timeout = setTimeout(() => {
      terminateProcessGroup(child);
      forceTimer = setTimeout(() => {
        terminateProcessGroup(child, 'SIGKILL');
        finish(false, `命令执行超过 ${timeoutMs / 1000} 秒。`);
      }, 500);
      forceTimer.unref?.();
    }, timeoutMs);
    timeout.unref?.();
  });
}

function cleanupSingleEpRuntime(target, stageDir) {
  if (!stageDir) return Promise.resolve({ success:true, error:'' });
  if (!/^\/tmp\/metax-singleep-[a-f0-9]{24}$/.test(stageDir)) {
    return Promise.resolve({ success:false, error:'SingleEP 临时目录格式无效，未执行清理。' });
  }
  const script = [
    'set -e',
    `stage_dir=${shellSingleQuote(stageDir)}`,
    'case "$stage_dir" in /tmp/metax-singleep-[a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9]) ;; *) exit 64 ;; esac',
    'rm -rf -- "$stage_dir" "${stage_dir}.upload"'
  ].join('\n') + '\n';
  return runTargetMaintenanceScript(target, script);
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

function executeSingleEpCase(config, testCase, target, runtimeTestDir, position, total, res, batch) {
  return new Promise((resolve) => {
    const recipe = singleEpCaseRecipe(config, testCase, runtimeTestDir);
    const launch = testLaunch(target, recipe.script, { runId:batch.runId });
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
    sendStreamEvent(res, {
      type:'case-start', index:position, total, testType:config.testType,
      typeLabel:config.typeLabel, rank:testCase.rank, tokens:testCase.tokens,
      hidden:testCase.hidden, command:recipe.preview, timeoutSeconds:recipe.timeoutMs / 1000
    });
    const stop = (error) => {
      if (finished) return launch.stopPromise || Promise.resolve({ confirmed:true });
      if (!terminalError) terminalError = error;
      if (!launch.stopPromise) launch.stopPromise = stopLaunchedTest(launch, child);
      return launch.stopPromise;
    };
    batch.stopCurrent = (message) => stop(new Error(message));
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
    child.on('close', async (code, signal) => {
      finished = true;
      clearTimeout(timeout);
      const cleanup = launch.stopPromise ? await launch.stopPromise : { confirmed:true };
      if (terminalError && !cleanup.confirmed) terminalError = new Error(`${terminalError.message}；无法确认测试程序已完全退出：${cleanup.error || '清理失败'}`);
      if (batch.child === child) batch.child = null;
      if (batch.stopCurrent) batch.stopCurrent = null;
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
    runId:createTestRunId(),
    stopKind:'',
    stopCurrent:null,
    stopPromise:null,
    cleanupConfirmed:true,
    runtimeTestDir:path.resolve(SINGLE_EP_TEST_DIR),
    runtimeStageDir:''
  };
  batch.requestStop = (message = '用户请求停止测试。', kind = 'user') => {
    if (kind === 'user') batch.stopKind = 'user';
    else if (!batch.stopKind) batch.stopKind = kind;
    batch.cancelled = true;
    if (!batch.stopPromise) {
      batch.stopPromise = batch.stopCurrent
        ? batch.stopCurrent(message).then((result) => { batch.cleanupConfirmed = result.confirmed; return result; })
        : Promise.resolve({ confirmed:true });
    }
    return batch.stopPromise;
  };
  activePerformanceTest = batch;
  const results = [];
  const onClose = () => {
    if (res.writableEnded) return;
    void batch.requestStop('浏览器已断开，测试任务已停止。', 'disconnect');
  };
  res.on('close', onClose);
  sendStreamEvent(res, {
    type:'start', testId:'singleep', label:batch.label, runId:batch.runId, testType:config.testType,
    typeLabel:config.typeLabel, total:config.cases.length,
    timeoutSeconds:SINGLE_EP_CASE_TIMEOUT_MS / 1000
  });
  try {
    const runtime = await prepareSingleEpRuntime(config, target, batch, res);
    batch.runtimeTestDir = runtime.testDir;
    for (let index = 0; index < config.cases.length; index += 1) {
      if (batch.cancelled || batch.fatalError) break;
      const result = await executeSingleEpCase(config, config.cases[index], target, batch.runtimeTestDir, index + 1, config.cases.length, res, batch);
      results.push(result);
      if (!batch.cancelled) sendStreamEvent(res, { type:'case-result', result });
    }
    if (batch.cancelled) {
      if (batch.stopPromise) await batch.stopPromise;
      const passed = results.filter((result) => result.success).length;
      sendStreamEvent(res, {
        type:'result', success:false, stopped:batch.stopKind === 'user', cleanupConfirmed:batch.cleanupConfirmed,
        total:config.cases.length, completed:results.length, passed, failed:results.length - passed,
        durationMs:Date.now() - batch.startedAt,
        error:batch.cleanupConfirmed ? '测试已停止，测试程序已确认退出。' : '停止已执行，但无法确认测试程序已完全退出。',
        results
      });
      if (!res.writableEnded) res.end();
    } else {
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
    if (batch.stopPromise) await batch.stopPromise;
    const runtimeCleanup = await cleanupSingleEpRuntime(target, batch.runtimeStageDir);
    if (!runtimeCleanup.success) console.warn(`SingleEP 远端临时目录清理失败：${runtimeCleanup.error}`);
    if (activePerformanceTest === batch) activePerformanceTest = null;
  }
}

function normalizeTestTarget(target) {
  if (!target || typeof target !== 'object' || Array.isArray(target)) throw new Error('测试目标格式无效。');
  if (!['local', 'remote'].includes(target.kind)) throw new Error('测试目标类型无效。');
  const password = typeof target.password === 'string' ? target.password : '';
  if (password.length > 512 || /[\r\n\0]/.test(password)) throw new Error('密码格式无效。');
  if (target.kind !== 'remote') return { kind:'local', password:'' };
  if (!/^[a-zA-Z0-9][a-zA-Z0-9.:-]*$/.test(target.host || '')) throw new Error('远程地址格式无效。');
  if (target.user && !/^[a-z_][a-z0-9_-]*$/i.test(target.user)) throw new Error('SSH 用户名格式无效。');
  const port = Number(target.port) || 22;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('SSH 端口必须在 1 到 65535 之间。');
  if (target.identityFile && (typeof target.identityFile !== 'string' || target.identityFile.length > 1024 || /[\r\n\0]/.test(target.identityFile))) throw new Error('私钥路径格式无效。');
  return {
    kind:'remote', host:String(target.host), user:String(target.user || ''), port,
    identityFile:String(target.identityFile || ''), password
  };
}

function remoteSshCommandLaunch(normalized, remoteCommand) {
  if (normalized.kind !== 'remote') throw new Error('SSH 命令只能用于远程测试目标。');
  const sshArgs = [
    '-o', `BatchMode=${normalized.password ? 'no' : 'yes'}`,
    '-o', 'NumberOfPasswordPrompts=1',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ConnectTimeout=8',
    '-p', String(normalized.port)
  ];
  if (normalized.identityFile) sshArgs.push('-i', normalized.identityFile);
  sshArgs.push(`${normalized.user ? `${normalized.user}@` : ''}${normalized.host}`, remoteCommand);
  return normalized.password
    ? { command:'sshpass', args:['-d', '3', 'ssh', ...sshArgs], fdPassword:normalized.password, target:normalized }
    : { command:'ssh', args:sshArgs, fdPassword:'', target:normalized };
}

function rawTestLaunch(target, script) {
  const normalized = normalizeTestTarget(target);
  if (normalized.kind !== 'remote') {
    return { command:'bash', args:['-s'], input:script, fdPassword:'', target:normalized };
  }
  return { ...remoteSshCommandLaunch(normalized, 'bash -s'), input:script };
}

function taggedTestScript(script, requestedRunId) {
  const runId = validTestRunId(requestedRunId);
  const delimiter = `__METAX_TEST_${runId.toUpperCase()}__`;
  return [
    'set +e',
    `metax_run_id=${shellSingleQuote(runId)}`,
    'metax_run_dir="${TMPDIR:-/tmp}/metax-inspection-$metax_run_id"',
    'umask 077',
    'mkdir "$metax_run_dir" || { printf "无法创建测试运行目录：%s\\n" "$metax_run_dir" >&2; exit 125; }',
    'metax_script="$metax_run_dir/test.sh"',
    `cat > "$metax_script" <<'${delimiter}'`,
    script.trimEnd(),
    delimiter,
    'chmod 700 "$metax_script"',
    'export METAX_INSPECTION_RUN_ID="$metax_run_id"',
    'metax_child=',
    'metax_child_group=no',
    'metax_local_cleanup() {',
    '  trap - HUP INT TERM',
    '  if [ -n "$metax_child" ] && kill -0 "$metax_child" 2>/dev/null; then',
    '    if [ "$metax_child_group" = yes ]; then kill -TERM -- "-$metax_child" 2>/dev/null || true; else kill -TERM "$metax_child" 2>/dev/null || true; fi',
    '    metax_wait=0',
    '    while kill -0 "$metax_child" 2>/dev/null && [ "$metax_wait" -lt 15 ]; do sleep 0.1; metax_wait=$((metax_wait + 1)); done',
    '    if kill -0 "$metax_child" 2>/dev/null; then',
    '      if [ "$metax_child_group" = yes ]; then kill -KILL -- "-$metax_child" 2>/dev/null || true; else kill -KILL "$metax_child" 2>/dev/null || true; fi',
    '    fi',
    '  fi',
    '  rm -f "$metax_script" "$metax_run_dir/pid" 2>/dev/null || true',
    '  rmdir "$metax_run_dir" 2>/dev/null || true',
    '}',
    "trap 'metax_local_cleanup; exit 143' HUP INT TERM",
    'if command -v setsid >/dev/null 2>&1; then',
    '  setsid bash "$metax_script" &',
    '  metax_child_group=yes',
    'else',
    '  bash "$metax_script" &',
    'fi',
    'metax_child=$!',
    'printf "%s\\n" "$metax_child" > "$metax_run_dir/pid"',
    'wait "$metax_child"',
    'metax_status=$?',
    'trap - HUP INT TERM',
    'metax_local_cleanup',
    'exit "$metax_status"'
  ].join('\n') + '\n';
}

function taggedProcessCleanupLines(requestedRunId) {
  const runId = validTestRunId(requestedRunId);
  return [
    `metax_run_id=${shellSingleQuote(runId)}`,
    'metax_run_dir="${TMPDIR:-/tmp}/metax-inspection-$metax_run_id"',
    'unset METAX_INSPECTION_RUN_ID',
    'metax_pid_is_tagged() {',
    '  metax_check_pid="$1"',
    '  case "$metax_check_pid" in ""|*[!0-9]*) return 1 ;; esac',
    '  [ -r "/proc/$metax_check_pid/environ" ] || return 1',
    '  { tr \'\\0\' \'\\n\' < "/proc/$metax_check_pid/environ"; } 2>/dev/null | grep -Fqx -- "METAX_INSPECTION_RUN_ID=$metax_run_id"',
    '}',
    'metax_tagged_pids() {',
    '  for metax_env in /proc/[0-9]*/environ; do',
    '    [ -r "$metax_env" ] || continue',
    '    if { tr \'\\0\' \'\\n\' < "$metax_env"; } 2>/dev/null | grep -Fqx -- "METAX_INSPECTION_RUN_ID=$metax_run_id"; then',
    '      metax_pid="${metax_env#/proc/}"; metax_pid="${metax_pid%/environ}"',
    '      case "$metax_pid" in ""|*[!0-9]*) ;; "$$"|"$PPID") ;; *) printf "%s\\n" "$metax_pid" ;; esac',
    '    fi',
    '  done',
    '}',
    'metax_stop_tagged() {',
    '  for metax_wait in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do',
    '    metax_pids="$(metax_tagged_pids)"',
    '    [ -n "$metax_pids" ] || break',
    '    for metax_pid in $metax_pids; do metax_pid_is_tagged "$metax_pid" && kill -TERM "$metax_pid" 2>/dev/null || true; done',
    '    sleep 0.1',
    '  done',
    '  if [ -n "$metax_pids" ]; then',
    '    for metax_wait in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do',
    '      metax_pids="$(metax_tagged_pids)"',
    '      [ -n "$metax_pids" ] || break',
    '      for metax_pid in $metax_pids; do metax_pid_is_tagged "$metax_pid" && kill -KILL "$metax_pid" 2>/dev/null || true; done',
    '      sleep 0.1',
    '    done',
    '  fi',
    '  rm -f "$metax_run_dir/test.sh" "$metax_run_dir/pid" 2>/dev/null || true',
    '  rmdir "$metax_run_dir" 2>/dev/null || true',
    '  [ -z "$(metax_tagged_pids)" ]',
    '}'
  ];
}

function testCleanupScript(requestedRunId, execution = { kind:'host' }) {
  const runId = validTestRunId(requestedRunId);
  const lines = ['set +e', 'metax_cleanup_failed=0'];
  if (execution.kind === 'container') {
    const delimiter = `__METAX_CONTAINER_CLEANUP_${runId.toUpperCase()}__`;
    lines.push(
      `metax_runtime=${shellSingleQuote(execution.runtime)}`,
      `metax_container=${shellSingleQuote(execution.id)}`,
      'if ! command -v "$metax_runtime" >/dev/null 2>&1 || ! "$metax_runtime" inspect "$metax_container" >/dev/null 2>&1; then',
      '  metax_cleanup_failed=1',
      'else',
      '  metax_container_running="$("$metax_runtime" inspect -f \'{{.State.Running}}\' "$metax_container" 2>/dev/null || true)"',
      '  if [ "$metax_container_running" = true ]; then',
      `    "$metax_runtime" exec -i "$metax_container" bash -s <<'${delimiter}'`,
      'set +e',
      ...taggedProcessCleanupLines(runId),
      'metax_stop_tagged',
      delimiter,
      '    [ $? -eq 0 ] || metax_cleanup_failed=1',
      '  fi',
      'fi'
    );
  } else if (execution.kind === 'image') {
    lines.push(
      `metax_runtime=${shellSingleQuote(execution.runtime)}`,
      `metax_container=${shellSingleQuote(execution.containerName)}`,
      'if ! command -v "$metax_runtime" >/dev/null 2>&1; then',
      '  metax_cleanup_failed=1',
      'else',
      '  for metax_container_wait in 1 2 3 4 5; do',
      '    "$metax_runtime" rm -f "$metax_container" >/dev/null 2>&1 || true',
      '    sleep 0.2',
      '  done',
      '  if "$metax_runtime" inspect "$metax_container" >/dev/null 2>&1; then metax_cleanup_failed=1; fi',
      'fi'
    );
  }
  lines.push(
    ...taggedProcessCleanupLines(runId),
    'metax_stop_tagged || metax_cleanup_failed=1',
    'exit "$metax_cleanup_failed"'
  );
  return `${lines.join('\n')}\n`;
}

function testLaunch(target, script, { runId = createTestRunId(), execution = { kind:'host' } } = {}) {
  const validatedRunId = validTestRunId(runId);
  const launch = rawTestLaunch(target, taggedTestScript(script, validatedRunId));
  return { ...launch, runId:validatedRunId, execution };
}

function terminateProcessGroup(child, signal = 'SIGTERM') {
  if (!child?.pid) return;
  try { process.kill(-child.pid, signal); }
  catch { try { child.kill(signal); } catch {} }
}

function waitForProcessClose(child, timeoutMs) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off('close', onClose);
      resolve(value);
    };
    const onClose = () => done(true);
    const timer = setTimeout(() => done(false), timeoutMs);
    timer.unref?.();
    child.once('close', onClose);
  });
}

function runTestCleanup(launch) {
  return new Promise((resolve) => {
    let cleanup;
    try { cleanup = rawTestLaunch(launch.target, testCleanupScript(launch.runId, launch.execution)); }
    catch (error) { return resolve({ success:false, error:errorMessage(error) }); }
    const hasPasswordFd = Boolean(cleanup.fdPassword);
    let child;
    try {
      child = spawn(cleanup.command, cleanup.args, {
        detached:true,
        stdio:hasPasswordFd ? ['pipe', 'ignore', 'pipe', 'pipe'] : ['pipe', 'ignore', 'pipe']
      });
    } catch (error) {
      return resolve({ success:false, error:errorMessage(error) });
    }
    let settled = false;
    let stderr = '';
    let timeout = null;
    let forceTimer = null;
    const finish = (success, error = '') => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (forceTimer) clearTimeout(forceTimer);
      resolve({ success, error:error || stderr.trim() });
    };
    child.stderr?.on('data', (chunk) => { if (stderr.length < 32_768) stderr += chunk.toString('utf8'); });
    child.stdin.on('error', () => {});
    child.on('error', (error) => finish(false, error.message));
    child.on('close', (code, signal) => {
      const detail = stderr.trim();
      finish(code === 0, code === 0 ? '' : `清理命令退出码 ${code ?? signal ?? '未知'}${detail ? `：${detail}` : ''}`);
    });
    if (hasPasswordFd) {
      child.stdio[3].on('error', () => {});
      child.stdio[3].end(`${cleanup.fdPassword}\n`);
    }
    child.stdin.end(cleanup.input);
    timeout = setTimeout(() => {
      terminateProcessGroup(child);
      forceTimer = setTimeout(() => {
        terminateProcessGroup(child, 'SIGKILL');
        finish(false, `停止清理超过 ${TEST_CLEANUP_TIMEOUT_MS / 1000} 秒。`);
      }, 500);
      forceTimer.unref?.();
    }, TEST_CLEANUP_TIMEOUT_MS);
    timeout.unref?.();
  });
}

function stopLaunchedTest(launch, child) {
  if (launch.stopPromise) return launch.stopPromise;
  launch.stopPromise = (async () => {
    terminateProcessGroup(child);
    const cleanupPromise = runTestCleanup(launch);
    let processExited = await waitForProcessClose(child, TEST_STOP_GRACE_MS);
    if (!processExited) {
      terminateProcessGroup(child, 'SIGKILL');
      processExited = await waitForProcessClose(child, 2_000);
    }
    const cleanup = await cleanupPromise;
    if (processExited) {
      child.stdin?.destroy();
      child.stdout?.destroy();
      child.stderr?.destroy();
    }
    return {
      confirmed:processExited && cleanup.success,
      processExited,
      cleanupSucceeded:cleanup.success,
      error:cleanup.error || (!processExited ? '测试启动进程未在强制终止后退出。' : '')
    };
  })();
  return launch.stopPromise;
}

function executePerformanceTest(recipe, launch, req, res) {
  return new Promise((resolve) => {
    const hasPasswordFd = Boolean(launch.fdPassword);
    const child = spawn(launch.command, launch.args, { detached: true, stdio: hasPasswordFd ? ['pipe', 'pipe', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'] });
    const startedAt = Date.now();
    let outputSize = 0;
    let terminalError = null;
    let finished = false;
    const active = { testId:recipe.testId, label:recipe.label, child, startedAt, runId:launch.runId, stopKind:'', stopPromise:null };
    activePerformanceTest = active;
    sendStreamEvent(res, { type:'start', testId:recipe.testId, label:recipe.label, runId:launch.runId, command:recipe.preview, timeoutSeconds:recipe.timeoutMs / 1000 });
    const stop = (error, kind = 'system') => {
      if (kind === 'user') active.stopKind = 'user';
      else if (!active.stopKind) active.stopKind = kind;
      if (finished) return active.stopPromise || Promise.resolve({ confirmed:true });
      if (!terminalError) terminalError = error;
      if (!active.stopPromise) active.stopPromise = stopLaunchedTest(launch, child);
      return active.stopPromise;
    };
    active.requestStop = (message = '用户请求停止测试。', kind = 'user') => stop(new Error(message), kind);
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
    child.on('close', async (code, signal) => {
      finished = true;
      clearTimeout(timeout);
      const cleanup = active.stopPromise ? await active.stopPromise : { confirmed:true };
      if (terminalError && !cleanup.confirmed) terminalError = new Error(`${terminalError.message}；无法确认测试程序已完全退出：${cleanup.error || '清理失败'}`);
      if (activePerformanceTest === active) activePerformanceTest = null;
      const durationMs = Date.now() - startedAt;
      if (terminalError) sendStreamEvent(res, { type:'error', error:terminalError.message, stopped:active.stopKind === 'user', cleanupConfirmed:cleanup.confirmed, durationMs });
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
  if (req.method === 'POST' && url.pathname === '/api/tests/stop') {
    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 1_000) return sendJson(res, 413, { error:'请求过大。' });
    }
    let payload;
    try { payload = JSON.parse(body || '{}'); }
    catch { return sendJson(res, 400, { error:'请求不是有效的 JSON。' }); }
    let runId;
    try { runId = validTestRunId(payload.runId); }
    catch (error) { return sendJson(res, 400, { error:errorMessage(error) }); }
    const active = activePerformanceTest;
    if (!active) return sendJson(res, 200, { stopped:true, confirmed:true, alreadyExited:true });
    if (active.runId !== runId) return sendJson(res, 409, { error:'运行标识与当前测试不匹配，未执行停止操作。' });
    try {
      const result = await active.requestStop('用户请求停止测试。', 'user');
      sendJson(res, 200, {
        stopped:true,
        confirmed:Boolean(result?.confirmed),
        error:result?.confirmed ? '' : (result?.error || '无法确认测试程序已完全退出。')
      });
    } catch (error) {
      sendJson(res, 500, { stopped:false, confirmed:false, error:errorMessage(error) });
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
      normalizeTestTarget(payload.target);
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
      const runId = createTestRunId();
      recipe = testRecipe(payload, runId);
      launch = testLaunch(payload.target, recipe.script, { runId, execution:recipe.execution });
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
server.listen(PORT, HOST, () => console.log(`沐曦通信库巡检平台: http://${HOST}:${PORT}`));
