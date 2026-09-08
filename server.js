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
const COLLECTION_TASKS = [
  ['META', '主机信息'], ['CPU', 'CPU / NUMA'], ['CPU_GOV', 'CPU 性能模式'],
  ['SYSTEM', '系统环境'], ['DMESG', '内核错误'], ['PCI_CTL', 'PCIe 控制'],
  ['PCI', 'PCIe 拓扑'], ['NET', '网卡设备'], ['IB', 'InfiniBand 状态'],
  ['IB_NET', 'RDMA 网口映射'], ['OFED', 'OFED 版本'], ['GIDS', 'GID 配置'],
  ['ROCE', 'RoCE 配置'], ['GPU_TOPO', 'GPU 拓扑'], ['GPU_HEALTH', 'GPU 状态'],
  ['MXLK', 'MetaxLink'], ['GPU_PCIE', 'GPU PCIe'], ['MACA', 'GPU 型号']
];
const COLLECTION_TASK_LABELS = new Map(COLLECTION_TASKS);

// This script only reads hardware state. Its tab-separated format is kept intentionally stable for parsing.
const INVENTORY_SCRIPT = String.raw`set +e
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
meta() { hostname; date -Is; }
cpu() { lscpu --json 2>/dev/null || lscpu; }
cpu_gov() { for p in /sys/devices/system/cpu/cpufreq/policy*/scaling_governor; do [ -r "$p" ] && printf '%s\t%s\n' "$(basename "$(dirname "$p")")" "$(cat "$p")"; done; }
system_info() {
  printf 'os\t%s\n' "$(grep '^PRETTY_NAME=' /etc/os-release 2>/dev/null | cut -d= -f2- | tr -d '\"' || echo unknown)"
  printf 'kernel\t%s\n' "$(uname -r 2>/dev/null || echo unknown)"
  printf 'arch\t%s\n' "$(uname -m 2>/dev/null || echo unknown)"
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
}
dmesg_info() { dmesg --level=emerg,alert,crit,err 2>&1 | tail -n 100; }
pcie_ctl() {
  lspci -Dvvv 2>/dev/null | awk '
    function flush() { if (b != "" && ctl != "") printf "%s\t%s\n", b, ctl }
    $1 ~ /^[[:xdigit:]]+:[[:xdigit:]]+:[[:xdigit:]]+\.[[:xdigit:]]$/ { flush(); b=$1; ctl=""; next }
    /ACSCtl:|ATSCtl:|RlxdOrd|MaxReadReq/ { line=$0; sub(/^[ \t]+/, "", line); ctl=ctl line ";" }
    END { flush() }
  '
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
  let type = 'device';
  if (classCode.startsWith('0x0604')) type = 'switch';
  else if ((classCode.startsWith('0x03') || /vga|3d controller|display controller|metax/.test(text)) && !/aspeed|ast\d{4}/.test(text)) type = 'gpu';
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

function parsePcieControls(text) {
  return new Map(text.split(/\r?\n/).filter(Boolean).map((line) => { const [bdf, controls = ''] = line.split('\t'); return [bdf, { raw: controls, acs: /ACSCtl:\s*([^;]+)/i.exec(controls)?.[1]?.trim() || '', ats: /ATSCtl:\s*([^;]+)/i.exec(controls)?.[1]?.trim() || '', ro: /RlxdOrd:\s*([^;]+)/i.exec(controls)?.[1]?.trim() || '', mrrs: /MaxReadReq\s*([^;]+)/i.exec(controls)?.[1]?.trim() || '' }]; }));
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
  const models = [...text.matchAll(/Market Name:\s*([^\n]+)/g)].map((match) => match[1].trim()).filter((value) => !/CPU|PROCESSOR/i.test(value));
  return { models: [...new Set(models)] };
}

function issue(title, message, reference) { return { title, message, reference }; }

function applyCompliance(nodes, cpuGovernors, ofed, controls, system, roce, gpuHealth, gpuCount, mxlk, gids, dmesg, requestedProfile = 'auto', macainfo = { models: [] }) {
  const cpuIssue = cpuGovernors.length && cpuGovernors.some((governor) => governor.mode !== 'performance')
    ? issue('CPU 非 performance 模式', `检测到 ${[...new Set(cpuGovernors.map((governor) => governor.mode))].join(', ')}；应设为 performance。`, '指南 3.1.1、9.4') : null;
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
  const acsOn = acsValues.filter((value) => /SrcValid\+/i.test(value)).length > 1;
  const iommuCount = Number(system.get('iommu_count') || 0);
  const iommuBad = isVirtualized
    ? (iommuCount === 0 || !/identity|dma|iommu=pt|iommu.passthrough=1/i.test(`${system.get('iommu_modes') || ''} ${system.get('cmdline') || ''}`))
    : (iommuCount > 0 && !/off|disable/i.test(system.get('cmdline') || ''));
  const globalIssues = [];
  if (acsOn && !isVirtualized) globalIssues.push(issue('PCIe ACS 已开启', `检测到 ${acsValues.filter((value) => /SrcValid\+/i.test(value)).length} 个 ACSCtl SrcValid+；物理机/Docker 推荐关闭 ACS。`, '指南 3.2.4.1'));
  if (!acsOn && acsValues.length && isVirtualized) globalIssues.push(issue('虚拟化场景 ACS 未开启', '虚拟化场景要求主机侧开启 ACS；当前未发现多个 ACSCtl SrcValid+。', '指南 3.2.2.2'));
  if (iommuBad) globalIssues.push(issue('IOMMU 未关闭', `检测到 ${iommuCount} 个 IOMMU 设备；物理机/Docker 推荐关闭 IOMMU。`, '指南 3.2.3'));
  const groups = system.get('groups') || '';
  if (system.get('video_group') === 'no') globalIssues.push(issue('当前用户不在 video 组', 'GPU 访问可能失败，建议将运行账户加入 video 组。', '指南 9.1'));
  if (!system.get('nofile_soft') || Number(system.get('nofile_soft')) < 4096) globalIssues.push(issue('文件描述符上限偏低', `当前 soft nofile=${system.get('nofile_soft') || '未知'}。大规模 all-to-all 任务可能需要提高上限。`, '指南 9.6'));
  const osIssue = !system.get('os') || !system.get('kernel') ? issue('系统信息不完整', '未能完整读取 OS 或内核版本，无法进行环境一致性核验。', '指南 3.2.1') : null;
  if (osIssue) globalIssues.push(osIssue);
  if (gpuHealth.attached !== null && gpuHealth.attached !== gpuCount) globalIssues.push(issue('GPU 数量不一致', `mx-smi 报告 ${gpuHealth.attached} 张，PCIe 枚举到 ${gpuCount} 张。`, '一键巡检 10.1.3.2'));
  if (gpuHealth.vbios.length > 1) globalIssues.push(issue('GPU VBIOS 版本不一致', `检测到多个 VBIOS 版本：${gpuHealth.vbios.join(', ')}。`, '一键巡检 10.3.2.2'));
  if (gpuHealth.maca.length > 1) globalIssues.push(issue('GPU MACA 版本不一致', `检测到多个 MACA 版本：${gpuHealth.maca.join(', ')}。`, '一键巡检 10.1.3.2'));
  if (gpuHealth.kmd.length > 1) globalIssues.push(issue('GPU KMD 版本不一致', `检测到多个 KMD 版本：${gpuHealth.kmd.join(', ')}。`, '一键巡检 10.1.3.2'));
  nodes.forEach((node) => {
    node.issues = [];
    if (node.type === 'cpu' && cpuIssue) node.issues.push(cpuIssue);
    if (node.type === 'cpu') node.issues.push(...globalIssues.filter((entry) => /ACS|IOMMU|video|文件描述符|系统信息|GPU/.test(entry.title)));
    if (node.type === 'gpu') node.issues.push(...globalIssues.filter((entry) => /GPU/.test(entry.title)));
    if (['gpu', 'nic', 'switch'].includes(node.type)) {
      const discoveredPcie = parsePcieLink(node.pcieLink || '');
      node.pcie = discoveredPcie.speed ? discoveredPcie : (node.gpuInfo?.pcie?.speed ? node.gpuInfo.pcie : discoveredPcie);
      if (node.pcie.speed && node.pcie.capSpeed && (node.pcie.speed !== node.pcie.capSpeed || node.pcie.width !== node.pcie.capWidth)) node.issues.push(issue('PCIe 链路降速', `当前 ${node.pcie.speed} x${node.pcie.width}，能力为 ${node.pcie.capSpeed} x${node.pcie.capWidth}。`, '指南 11.3、9.2.3'));
      const control = controls.get(node.bdf); if (control) { node.controls = control; if (control.ats && /Disabled|\-$/i.test(control.ats) && isVirtualized) node.issues.push(issue('虚拟化场景 ATS 未开启', `当前 ATSCtl: ${control.ats}；虚拟机要求 GPU/NIC 上游 PCIe bridge 配置 ATS。`, '指南 3.2.2.2')); if (control.ro && /Disabled|\-$/i.test(control.ro) && node.type === 'nic') node.issues.push(issue('NIC Relaxed Ordering 未开启', `当前 RlxdOrd: ${control.ro}。`, '指南 4.12.1.2')); }
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
  const checks = [
    { id:'acs', name:'PCIe ACS', value:acsValues.length ? (acsOn ? '已开启' : '已关闭/未发现多个 SrcValid+') : '未检测到', status:acsValues.length ? (acsOn && !isVirtualized ? 'fail' : 'pass') : 'unknown', reference:'指南 3.2.4.1' },
    { id:'iommu', name:'IOMMU', value:iommuCount ? `${iommuCount} 个设备 · ${system.get('iommu_modes') || '模式未知'}` : '未启用', status:iommuBad ? 'fail' : 'pass', reference:'指南 3.2.3' },
    { id:'cpu', name:'CPU Governor', value:cpuGovernors.length ? [...new Set(cpuGovernors.map((item) => item.mode))].join(', ') : '未检测到', status:cpuIssue ? 'fail' : cpuGovernors.length ? 'pass' : 'unknown', reference:'指南 3.1.1' },
    { id:'ofed', name:'OFED', value:ofedVersion || '未检测到', status:ofedIssue ? 'fail' : 'pass', reference:'指南 8.6.1' },
    { id:'nic-speed', name:'计算网卡速率', value:slowNics.length ? `${slowNics.length} 个网口低于 100G` : '未发现低于 100G 的计算网口', status:slowNics.length ? 'fail' : 'pass', reference:'指南 2.3、4.5' },
    { id:'gpu-count', name:'GPU 数量', value:gpuHealth.attached === null ? `${gpuCount} 张 PCIe 设备` : `${gpuHealth.attached} / ${gpuCount}`, status:gpuHealth.attached !== null && gpuHealth.attached !== gpuCount ? 'fail' : gpuHealth.attached === null ? 'unknown' : 'pass', reference:'一键巡检 10.1.3.2' },
    { id:'video', name:'video 组', value:system.get('video_group') || '未检测到', status:system.get('video_group') === 'yes' ? 'pass' : 'fail', reference:'指南 9.1' },
    { id:'nofile', name:'文件描述符', value:`soft ${system.get('nofile_soft') || '?'} / hard ${system.get('nofile_hard') || '?'}`, status:Number(system.get('nofile_soft')) >= 4096 ? 'pass' : 'warn', reference:'指南 9.6' },
    { id:'pcie-controls', name:'PCIe ACS/ATS/RO/MRRS', value:controls.size ? `已读取 ${controls.size} 个 PCIe 设备` : '权限不足或设备不支持', status:controls.size ? 'pass' : 'unknown', reference:'指南 3.2.2、3.2.4、4.12' },
    { id:'gpu-health', name:'GPU / VBIOS', value:gpuHealth.attached === null ? '未解析 mx-smi 健康信息' : `${gpuHealth.attached} 张 · ${gpuHealth.vbios.length || 0} 个 VBIOS 版本`, status:gpuHealth.unavailable ? 'unknown' : (gpuHealth.vbios.length > 1 || gpuHealth.maca.length > 1 || gpuHealth.kmd.length > 1 || (gpuHealth.attached !== null && gpuHealth.attached !== gpuCount) ? 'fail' : 'pass'), reference:'一键巡检 10.3.2.2' },
    { id:'gpu-model', name:'GPU 型号', value:macainfo.models.length ? macainfo.models.join(', ') : '未检测到 macainfo 型号', status:macainfo.models.length ? 'pass' : 'unknown', reference:'macainfo' },
    { id:'metaxlink', name:'MetaxLink', value:/not found|unrecognized option|invalid option|error/i.test(mxlk) ? '未检测到或命令不支持' : '已采集链路状态', status:/not found|unrecognized option|invalid option|error/i.test(mxlk) ? 'unknown' : 'pass', reference:'指南 9.2.1' },
    { id:'roce', name:'RoCE PFC/ECN/DSCP', value:roce.size ? `已读取 ${roce.size} 个网口配置` : '未检测到或非 RoCE', status:roce.size ? 'unknown' : 'unknown', reference:'指南 4.9' },
    { id:'gid', name:'GID 配置', value:/not found|command not found|error/i.test(gids) ? '未检测到 show_gids' : '已采集，需跨节点比对', status:/not found|command not found|error/i.test(gids) ? 'unknown' : 'unknown', reference:'指南 4.8.4.4、4.9.1' },
    { id:'dmesg', name:'dmesg 错误', value:/Operation not permitted|Permission denied/i.test(dmesg) ? '权限不足' : (dmesg ? '发现错误输出，详见诊断' : '未发现 error 级输出'), status:/Operation not permitted|Permission denied/i.test(dmesg) ? 'unknown' : (dmesg ? 'warn' : 'pass'), reference:'一键巡检 10.3.3.5' },
    { id:'vswitch', name:'VSwitch', value:system.get('vswitch_links') === 'present' ? '发现拓扑文件' : '未发现拓扑文件', status:system.get('vswitch_links') === 'present' ? 'pass' : 'unknown', reference:'指南 3.1.2、9.7' }
  ];
  return { cpuGovernors, system: Object.fromEntries(system), globalIssues, profile: requestedProfile, detectedProfile: detectedVirtualized ? 'virtualized' : 'physical', checks, acs: { values: acsValues, enabled: acsOn, isVirtualized }, iommu: { count: iommuCount, modes: system.get('iommu_modes') || '', required: isVirtualized ? 'PT/identity' : 'disabled' }, ofed: { raw: ofed.trim(), version: ofedVersion || '未检测到', valid: !ofedIssue }, gpu: { reported: gpuHealth, models: macainfo.models, discovered: gpuCount }, issueCount: nodes.reduce((count, node) => count + node.issues.length, 0) };
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
  const cpuGovernors = sections.CPU_GOV.trim().split(/\r?\n/).filter(Boolean).map((line) => { const [policy, mode] = line.split('\t'); return { policy, mode }; });
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
    const sshArgs = ['-o', `BatchMode=${password ? 'no' : 'yes'}`, '-o', 'NumberOfPasswordPrompts=1', '-o', 'ConnectTimeout=8', '-p', String(port)];
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
    if (command === 'sshpass' && error.code === 6) throw new Error('SSH 主机密钥尚未确认，请先在服务端命令行连接一次该主机。');
    if (command === 'sshpass' && error.code === 7) throw new Error('SSH 主机密钥已变更，请检查 known_hosts。');
    throw error;
  }
  return parseInventory(stdout, target.kind === 'remote' ? target.host : '本机', profile);
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
  const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  const fullPath = path.resolve(PUBLIC_DIR, file);
  if (!fullPath.startsWith(PUBLIC_DIR) || !fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) { res.writeHead(404); return res.end('Not found'); }
  const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8' };
  res.writeHead(200, { 'Content-Type': types[path.extname(fullPath)] || 'application/octet-stream' });
  fs.createReadStream(fullPath).pipe(res);
});
server.listen(PORT, HOST, () => console.log(`Machine Topology: http://${HOST}:${PORT}`));
