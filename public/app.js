const state = {
  kind: 'local', data: null, selected: null, output: 'gpuTopo', positions: null,
  collapsed: new Set(), graphWidth: 1320, graphHeight: 600,
  view: { x: 0, y: 0, zoom: 1 }, gesture: null, progressHideTimer: null,
  page: 'single', singleView: 'info',
  tests: { selected: 'gpu-vector-add', results: new Map(), controller: null, running: null, runId: null, stopRequested: false, stopConfirmed: false, stopError: '' },
  ep: { results: [], controller: null, running: false, runId: null, stopRequested: false, stopConfirmed: false, stopError: '', total: 0, completed: 0, current: null, status: 'idle' },
  cluster: { size: 2, data: null, selected: null, running: false, progress: new Map(), error: '' },
  auth: { remotePasswords: new Map() }
};
const $ = (selector) => document.querySelector(selector);
const svgEl = (name, attrs = {}) => { const el = document.createElementNS('http://www.w3.org/2000/svg', name); Object.entries(attrs).forEach(([key, value]) => el.setAttribute(key, value)); return el; };
const INVENTORY_TASK_COUNT = 19;
const IB_WRITE_BW_PATH = '/opt/maca/tools/communication/rdma/perftest/tests/ib_write_bw';
const MACA_MPIRUN_PATH = '/opt/maca/ompi/bin/mpirun';
const MCCL_ALLTOALL_PATH = '/opt/maca/samples/mccl_tests/perf/mccl_perf/alltoall_perf';
const MACA_LIBRARY_PATH_PREVIEW = 'export LD_LIBRARY_PATH=/opt/maca/lib:$LD_LIBRARY_PATH';

const TEST_DEFINITIONS = [
  { id:'gpu-vector-add', group:'GPU 单项', kind:'gpu', symbol:'VEC', title:'GPU vectorAdd', summary:'多卡基础计算正确性', description:'编译一次 MACA vectorAdd 示例，并依次验证每张所选 GPU 的基础计算和内存访问。', fields:['gpus'] },
  { id:'nic-p2p', group:'网卡测试', kind:'nic', symbol:'P2P', title:'P2P', summary:'双 GPU 本机互测', description:'在当前目标内选择两张 GPU，并分别绑定 RDMA HCA（可使用同一个 HCA）；服务端和客户端通过 localhost 自动完成 ib_write_bw 测试。', fields:['p2p','transport','gid','topology'] },
  { id:'nic-alltoall', group:'网卡测试', kind:'nic', symbol:'A2A', title:'alltoall', summary:'多 GPU / 多 HCA 并发', description:'使用 MCCL alltoall_perf 验证所选 GPU 与 RDMA HCA 范围的并发 IB RC 通路。', fields:['gpus','nics','transport','gid','topology'] },
  { id:'host-ibrc', group:'单机通信', kind:'host', symbol:'RC', title:'IBRC', summary:'MCCL IB RC alltoall', description:'使用 MCCL alltoall_perf 验证单机多 GPU 经 IB RC 通路的通信能力。', fields:['gpuCount','hca'] },
  { id:'host-ibgda', group:'单机通信', kind:'host', symbol:'GDA', title:'IBGDA', summary:'mxdeepep internode', description:'使用 mxdeepep test_internode 验证单机多 GPU 的 IBGDA 通信通路。', fields:['gpuCount','hca'] }
];

const CLUSTER_CHECK_DEFINITIONS = [
  { id:'machine-config', name:'机器配置一致性', symbol:'HOST' },
  { id:'nic-firmware', name:'网卡固件一致性', symbol:'NIC FW' },
  { id:'nic-speed', name:'网卡速率一致性', symbol:'NIC BW' },
  { id:'gpu-firmware', name:'GPU 固件一致性', symbol:'GPU FW' },
  { id:'gpu-model', name:'GPU 型号一致性', symbol:'GPU' },
  { id:'topology', name:'拓扑一致性', symbol:'TOPO' }
];

const EP_TEST_OPTIONS = {
  'low-latency': {
    label:'Low Latency', ranks:[1,2,4,8,16,32], tokens:[1,2,4,8,16,32,64],
    defaultRank:'1', defaultToken:'1', hint:'单机 P2P，支持 1/2/4/8/16/32 ranks'
  },
  intranode: {
    label:'Intranode', ranks:[2,4,8], tokens:[128,256,512,1024,2048,4096,8192],
    defaultRank:'2', defaultToken:'128', hint:'单机 CUDA IPC，启动器仅支持 2/4/8 ranks'
  },
  internode: {
    label:'Internode', ranks:[16], tokens:[128,256,512,1024,2048,4096,8192],
    defaultRank:'16', defaultToken:'128', hint:'两个连续 8-rank 逻辑节点，启动器固定 16 ranks'
  }
};

function deviceIcon(type) { return ({ cpu: 'CPU', gpu: 'GPU', switch: 'SW', nic: 'NIC' })[type] || 'PCI'; }
function pcieSummary(pcie) { return pcie?.speed ? `${pcie.speed} × x${pcie.width || '?'}` : '速率未知'; }
function switchUplinkMode(node) { const count = node.switchInfo?.upstreamCount || 0; return count >= 2 ? '双上行' : count === 1 ? '单上行' : '上行未知'; }
function deviceMeta(node) {
  if (node.type === 'cpu') return `NUMA ${node.numa} · ${node.attachedSwitchCount || 0} 个 PCIe Switch`;
  if (node.type === 'gpu') { const gpu = node.gpuInfo || {}; return `${gpu.model || '型号未知'} · HBM ${gpu.hbmTotal || '未知'} · ${gpu.clock || '频率未知'} · 利用率 ${Number.isFinite(gpu.utilization) ? `${gpu.utilization}%` : '未知'} · ${node.bdf}`; }
  if (node.type === 'switch') return `${node.switchInfo?.gpuCount || 0} GPU · ${node.switchInfo?.nicCount || 0} NIC · ${switchUplinkMode(node)} · ${pcieSummary(node.pcie)}`;
  if (node.type === 'nic') { const nic = node.nicInfo || {}; const hca = node.ib?.hca ? `${node.ib.hca} · ` : ''; return `${nic.isManagement ? '管理网 · ' : ''}${hca}${nic.transport || 'Ethernet'} · ${nic.speedLabel || '速率未知'} · ${nic.isUp ? 'up' : (node.net?.state || 'unknown')}`; }
  return node.bdf;
}
function graphMeta(node) {
  if (node.type === 'cpu') return `${node.attachedSwitchCount || 0} 个 PCIe Switch`;
  if (node.type === 'gpu') return `${node.gpuInfo?.model || node.bdf} · ${Number.isFinite(node.gpuInfo?.utilization) ? `${node.gpuInfo.utilization}%` : '利用率未知'}`;
  if (node.type === 'nic') return `${node.nicInfo?.isManagement ? '管理网' : (node.nicInfo?.transport || 'NIC')} · ${node.nicInfo?.speedLabel || '速率未知'}`;
  if (node.type === 'switch') return `${node.switchInfo?.gpuCount || 0}G / ${node.switchInfo?.nicCount || 0}N · ${switchUplinkMode(node)}`;
  return deviceMeta(node);
}
function compareDevices(a, b) {
  const rank = { cpu:0, switch:1, gpu:2, nic:3 };
  if (a.type !== b.type) return rank[a.type] - rank[b.type];
  if (a.type === 'nic') {
    if (Boolean(a.nicInfo?.isManagement) !== Boolean(b.nicInfo?.isManagement)) return a.nicInfo?.isManagement ? -1 : 1;
    if (Boolean(a.nicInfo?.isUp) !== Boolean(b.nicInfo?.isUp)) return a.nicInfo?.isUp ? -1 : 1;
    if ((a.nicInfo?.speedGbps || 0) !== (b.nicInfo?.speedGbps || 0)) return (b.nicInfo?.speedGbps || 0) - (a.nicInfo?.speedGbps || 0);
  }
  return a.label.localeCompare(b.label, 'zh-CN', { numeric:true });
}
function updateProgress({ completed = 0, total = INVENTORY_TASK_COUNT, label = '准备采集', done = false, error = false }) {
  const progress = $('#scan-progress');
  const percent = done ? 100 : Math.min(96, Math.round((completed / Math.max(1, total)) * 96));
  progress.hidden = false;
  progress.classList.toggle('complete', done);
  progress.classList.toggle('error', error);
  progress.setAttribute('aria-valuenow', String(percent));
  $('.progress-track i').style.width = `${percent}%`;
  $('#progress-label').textContent = error ? '采集失败' : done ? '采集完成 · 100%' : `已完成 ${completed}/${total} · ${label}`;
}
function setLoading(value, useRoot = false) {
  if (state.progressHideTimer) { clearTimeout(state.progressHideTimer); state.progressHideTimer = null; }
  const activeId = useRoot ? 'root-scan' : 'scan';
  const labels = { scan: '采集拓扑', 'root-scan': 'Root 采集' };
  ['scan', 'root-scan'].forEach((id) => {
    const button = $(`#${id}`);
    button.disabled = value;
    button.querySelector('.spinner').hidden = !value || id !== activeId;
    button.querySelector('.button-label').textContent = value && id === activeId ? (useRoot ? 'Root 采集中...' : '采集中...') : labels[id];
  });
  if (value) updateProgress({ completed: 0, total: INVENTORY_TASK_COUNT, label: '建立连接' });
}
function finishLoading(success) {
  setLoading(false);
  if (!success) return;
  updateProgress({ completed: INVENTORY_TASK_COUNT, total: INVENTORY_TASK_COUNT, done: true });
  state.progressHideTimer = setTimeout(() => { $('#scan-progress').hidden = true; }, 1200);
}
function setTopConnection(status, text) { const target = $('#connection'); target.className = `connection ${status || ''}`.trim(); target.replaceChildren(document.createElement('i'), document.createTextNode(text)); }
function displayError(message) { if (state.page === 'single') setTopConnection('error', '采集失败'); $('#scan-note').textContent = message; updateProgress({ error: true }); }
function updateGraphSelection() { document.querySelectorAll('#graph .node').forEach((node) => node.classList.toggle('selected', node.getAttribute('data-node-id') === state.selected)); }
function selectNode(id, redrawGraph = true) { state.selected = id; renderDevices(); renderDetail(); if (redrawGraph) renderGraph(); else updateGraphSelection(); }
function toggleNode(id) {
  if (!state.data?.edges.some((edge) => edge.target === id)) return;
  if (state.collapsed.has(id)) state.collapsed.delete(id); else state.collapsed.add(id);
  state.selected = id; renderDevices(); renderDetail(); renderGraph();
}

function renderHeader() {
  const { data } = state; if (!data) return;
  $('#hostname').textContent = data.hostname;
  $('#collected-at').textContent = `来源：${data.source} · 采集于 ${data.collectedAt}`;
  [['cpu', 'cpus'], ['gpu', 'gpus'], ['nic', 'nics'], ['switch', 'switches']].forEach(([key, name]) => { $(`#count-${key}`).textContent = data.summary[name]; });
  const issues = data.compliance?.issueCount || 0; if (state.page === 'single') setTopConnection(issues ? 'error' : 'ready', issues ? `${issues} 项待处理` : '检查通过');
  const summary = $('#compliance-summary'); summary.className = `compliance-summary ${issues ? 'has-issues' : 'ok'}`; const profile = data.compliance?.profile === 'auto' ? `自动识别为${data.compliance?.detectedProfile === 'virtualized' ? '虚拟化' : '物理机/Docker'}` : (data.compliance?.profile === 'virtualized' ? '虚拟化' : '物理机/Docker'); summary.textContent = `${profile} · ${issues ? `发现 ${issues} 项待处理配置` : '已采集规则均符合'}`;
  $('#scan-note').textContent = '采集完成。未修改目标机器上的任何配置。';
}
function repairFor(title) {
  const fixes = { 'CPU 非 performance 模式':'echo performance | sudo tee /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor', 'PCIe ACS 已开启':'物理机/Docker：关闭 BIOS ACS，并按指南关闭 IOMMU 后重启；虚拟机请确认运行模式。', 'IOMMU 未关闭':'物理机/Docker：检查 /proc/cmdline 与 /sys/class/iommu；按指南关闭后重启。', 'DMA-BUF / PEERMEM 均不可用':'优先按指南 8.5.7 升级到支持 DMA-BUF 的内核、RDMA 驱动和 MACA SDK；也可按 9.3.2.1 修复 PEERMEM 注册。', 'OFED 版本不在已验证范围':'安装项目确认过的 MLNX/DOCA OFED 版本（指南 8.6.1）。', '未检测到 OFED':'安装 OFED 后重新执行 ofed_info -s。', '当前用户不在 video 组':'sudo usermod -aG video <用户名>，重新登录。', '文件描述符上限偏低':'提高 /etc/security/limits.conf 的 nofile，并重新登录。', '同型号网卡固件不一致':'使用供应商或 NVIDIA 固件包，将同 CA type 网卡统一到同一版本。', '计算网卡链路非 Active':'检查网线、交换机端口和 IB/RoCE 模式。', 'NIC MRRS 大于 256':'按指南将计算网卡 MaxReadReq 配置为 256 bytes，并在变更前确认设备 BDF。', 'PCIe 链路降速':'检查上游 PCIe Switch、插槽和链路训练状态。' }; return fixes[title] || '请结合部署指南对应章节和集群配置进行处理。'; }
function renderInspection() {
  const container = $('#inspection-checks'); container.replaceChildren(); const checks = state.data?.compliance?.checks || []; if (!checks.length) return container.append(Object.assign(document.createElement('p'), { className:'empty', textContent:'采集后显示基础环境检查。' }));
  const counts = { fail:0, warn:0, pass:0, unknown:0 }; checks.forEach((check) => { counts[check.status] = (counts[check.status] || 0) + 1; const item = document.createElement('button'); item.className = `check-item ${check.status}`; item.title = `${check.name}: ${check.value}${check.detail ? `\n${check.detail}` : ''}`; const dot = document.createElement('i'); const name = document.createElement('strong'); name.textContent = check.name; const value = document.createElement('span'); value.textContent = check.value; const status = document.createElement('b'); status.textContent = ({fail:'异常',warn:'注意',pass:'正常',unknown:'待核验'})[check.status]; item.append(dot, name, value, status); container.append(item); }); $('#inspection-total').textContent = `${counts.fail} 异常 · ${counts.warn} 注意 · ${counts.unknown} 待核验`; }
function renderDevices() {
  const list = $('#device-list'); list.replaceChildren();
  if (!state.data) return list.append(Object.assign(document.createElement('p'), { className: 'empty', textContent: '尚无采集结果' }));
  $('#device-total').textContent = state.data.nodes.length;
  const ordered = [...state.data.nodes].sort(compareDevices);
  const groups = { cpu:'CPU / NUMA', switch:'PCIe Switch', gpu:'GPU', nic:'NIC' }; const counts = { cpu:0, switch:0, gpu:0, nic:0 }; ordered.forEach((node) => { counts[node.type] = (counts[node.type] || 0) + 1; });
  Object.entries(groups).forEach(([type, label]) => { const items = ordered.filter((node) => node.type === type); if (!items.length) return; const details = document.createElement('details'); details.className = 'device-group'; details.open = type === 'cpu' || items.some((node) => node.id === state.selected || node.status === 'invalid'); const summary = document.createElement('summary'); summary.innerHTML = `<span>${label}</span><b>${items.length}</b>`; details.append(summary); items.forEach((node) => { const slowNic = node.type === 'nic' && !node.nicInfo?.isManagement && node.nicInfo?.speedGbps > 0 && node.nicInfo.speedGbps < 100; const button = document.createElement('button'); button.className = `device-item ${node.status === 'invalid' ? 'invalid' : ''} ${node.id === state.selected ? 'selected' : ''} ${node.nicInfo?.isManagement ? 'management' : ''} ${slowNic ? 'slow-nic' : ''}`; button.onclick = () => selectNode(node.id); button.title = deviceMeta(node); const icon = document.createElement('span'); icon.className = `device-icon ${node.type}`; icon.textContent = node.nicInfo?.isManagement ? 'MGT' : deviceIcon(node.type); const labels = document.createElement('span'); const name = document.createElement('span'); name.className = 'device-name'; name.textContent = node.label; if (node.nicInfo?.isManagement) { const tag = document.createElement('em'); tag.className = 'device-tag management-tag'; tag.textContent = '管理'; name.append(tag); } if (slowNic) { const tag = document.createElement('em'); tag.className = 'device-tag warning-tag'; tag.textContent = '<100G'; name.append(tag); } if (node.issues?.length) { const flag = document.createElement('b'); flag.className = 'issue-count'; flag.textContent = node.issues.length; name.append(flag); } const meta = document.createElement('span'); meta.className = 'device-meta'; meta.textContent = deviceMeta(node); labels.append(name, meta); button.append(icon, labels); details.append(button); }); list.append(details); });
}
function addField(parent, term, value, code = false) { const row = document.createElement('div'); const dt = document.createElement('dt'); dt.textContent = term; const dd = document.createElement('dd'); if (code) { const c = document.createElement('code'); c.textContent = value; dd.append(c); } else dd.textContent = value; row.append(dt, dd); parent.append(row); }
function renderDetail() {
  const target = $('#detail'); target.replaceChildren(); const node = state.data?.nodes.find((item) => item.id === state.selected); if (!node) return target.append(Object.assign(document.createElement('p'), { className: 'empty', textContent: '在左侧设备列表或图中选择设备。' }));
  const badge = document.createElement('span'); badge.className = `badge ${node.status === 'invalid' ? 'invalid' : ''}`; badge.textContent = node.status === 'invalid' ? `${deviceIcon(node.type)} · 待处理` : `${deviceIcon(node.type)} · 已检查`; const title = document.createElement('h3'); title.textContent = node.label;
  target.append(badge, title);
  if (node.issues?.length) { const issues = document.createElement('section'); issues.className = 'issue-list'; const heading = document.createElement('h4'); heading.textContent = `不符合项 (${node.issues.length})`; issues.append(heading); node.issues.forEach((entry) => { const article = document.createElement('article'); const strong = document.createElement('strong'); strong.textContent = entry.title; const message = document.createElement('p'); message.textContent = entry.message; const reference = document.createElement('small'); reference.textContent = entry.reference; article.append(strong, message, reference); issues.append(article); }); target.append(issues); }
  const dl = document.createElement('dl');
  addField(dl, node.type === 'gpu' ? 'PCIe 号' : '设备地址', node.bdf || `NUMA ${node.numa}`, true);
  addField(dl, 'NUMA 节点', node.numa ?? '-');
  if (node.type === 'cpu') {
    addField(dl, '挂载 PCIe Switch', `${node.attachedSwitchCount || 0} 个`);
    const governors = state.data.compliance?.cpuGovernors || [];
    const abnormalGovernors = governors.filter((item) => item.mode !== 'performance');
    const governorSummary = governors.length
      ? abnormalGovernors.length
        ? `${governors.length - abnormalGovernors.length}/${governors.length} 个策略为 performance；异常：${abnormalGovernors.map((item) => `${item.policy}: ${item.mode}`).join(', ')}`
        : `全部 ${governors.length} 个策略均为 performance`
      : '未检测到';
    addField(dl, 'CPU Performance 模式', governorSummary, true);
  }
  if (node.type === 'gpu') {
    const gpu = node.gpuInfo || {};
    addField(dl, 'GPU 型号', gpu.model || '未检测到', true);
    addField(dl, 'HBM 大小', gpu.hbmTotal || '未检测到');
    addField(dl, '核心频率', gpu.clock || '未检测到');
    addField(dl, 'GPU 使用率', Number.isFinite(gpu.utilization) ? `${gpu.utilization}%` : '未检测到');
    addField(dl, 'GPU VBIOS', gpu.vbios || '未检测到', true);
    addField(dl, 'MACA 版本', gpu.maca || '未检测到', true);
    addField(dl, 'KMD 版本', gpu.kmd || '未检测到', true);
    if (gpu.pcie?.speed) {
      addField(dl, 'mx-smi PCIe 当前链路', `${gpu.pcie.speed} x${gpu.pcie.width || '?'}`, true);
      addField(dl, 'mx-smi PCIe 最大链路', `${gpu.pcie.capSpeed || '未知'} x${gpu.pcie.capWidth || '?'}`, true);
    }
  }
  if (node.type === 'switch') {
    const info = node.switchInfo || {};
    addField(dl, '下挂设备', `${info.gpuCount || 0} 个 GPU · ${info.nicCount || 0} 个 NIC`);
    addField(dl, '上行模式', `${switchUplinkMode(node)}（系统可见 ${info.upstreamCount || 0} 条）`);
    addField(dl, '上行 PCIe 号', info.upstreamBdfs?.join(', ') || '未检测到', true);
    addField(dl, '上行链路配置', node.pcie?.speed ? `当前 ${node.pcie.speed} x${node.pcie.width || '?'} · 最大 ${node.pcie.capSpeed || '未知'} x${node.pcie.capWidth || '?'}` : '未检测到', true);
  }
  if (node.type === 'nic') {
    const nic = node.nicInfo || {};
    addField(dl, '网络角色', nic.isManagement ? '管理网' : /^(RoCE|IB)$/.test(nic.transport || '') ? '计算网' : '普通网络');
    addField(dl, 'RDMA 设备名', node.ib?.hca || '未检测到', true);
    addField(dl, '网卡类型', nic.transport || 'Ethernet');
    addField(dl, '网口速率', nic.speedLabel || node.ib?.rate || node.net?.speed || '未检测到');
    addField(dl, 'IP 地址', node.net?.addresses?.join(', ') || '未配置', true);
  }
  if (node.description) addField(dl, '型号', node.description);
  if (node.driver) addField(dl, 'PCI 驱动', node.driver, true);
  if (node.controls) { addField(dl, 'ACS 控制', node.controls.acs || '未检测到', true); addField(dl, 'ATS 控制', node.controls.ats || '未检测到', true); addField(dl, 'Relaxed Ordering', node.controls.ro || '未检测到', true); addField(dl, 'MaxReadReq / MRRS', node.controls.mrrs || '未检测到', true); }
  if (node.pcie?.speed && node.type !== 'switch') { addField(dl, '当前 PCIe 链路', `${node.pcie.speed} x${node.pcie.width || '?'}`, true); addField(dl, 'PCIe 链路能力', `${node.pcie.capSpeed || '未知'} x${node.pcie.capWidth || '?'}`, true); }
  if (node.net) { addField(dl, '网络接口', node.net.name, true); addField(dl, '网口状态', node.nicInfo?.isUp ? 'up' : (node.net.state || 'unknown')); addField(dl, '网卡驱动', `${node.net.driver || '-'} ${node.net.version || ''}`.trim(), true); addField(dl, '网卡固件', node.ib?.firmware || node.net.firmware || '未检测到', true); if (node.roce) { addField(dl, 'PFC/QoS', node.roce.pfc || '未检测到'); addField(dl, 'ECN', node.roce.ecn || '未检测到'); addField(dl, 'DSCP / Traffic class', node.roce.tos || '未检测到'); } }
  if (node.ib) { addField(dl, 'RDMA CA 类型', node.ib.caType || '未检测到', true); addField(dl, 'RDMA 状态', node.ib.state || '未检测到'); }
  if (node.chain?.length) addField(dl, 'PCIe 路径', node.chain.join(' → '), true);
  target.append(dl);
  if (node.issues?.length) { const fixes = document.createElement('section'); fixes.className = 'fix-list'; const heading = document.createElement('h4'); heading.textContent = '建议处理'; fixes.append(heading); node.issues.forEach((entry) => { const p = document.createElement('p'); p.textContent = repairFor(entry.title); fixes.append(p); }); target.append(fixes); }
}
function layout(nodes, edges) {
  const out = new Map();
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const parentById = new Map(edges.map((edge) => [edge.source, edge.target]));
  const lineage = (node) => {
    const ids = [node.id]; let current = node.id; let guard = 0;
    while (parentById.has(current) && guard++ < 5) { current = parentById.get(current); ids.unshift(current); }
    return ids.map((id) => nodeById.get(id)?.label || id).join(' / ');
  };
  const groups = Object.fromEntries(['cpu', 'switch', 'gpu', 'nic'].map((type) => [type, nodes.filter((node) => node.type === type).sort((a, b) => lineage(a).localeCompare(lineage(b), 'zh-CN', { numeric: true }))]));
  const columnCount = (items) => Math.max(1, Math.ceil(items.length / 18));
  const rowCount = (items) => Math.max(1, Math.ceil(items.length / columnCount(items)));
  const gpuColumns = columnCount(groups.gpu); const nicColumns = columnCount(groups.nic);
  const starts = { cpu: 130, switch: 510, gpu: 930, nic: 930 + gpuColumns * 150 + 260 };
  const maxRows = Math.max(...Object.values(groups).map(rowCount));
  const rowGap = 76; const height = Math.max(600, (maxRows - 1) * rowGap + 144);
  Object.entries(groups).forEach(([type, items]) => {
    const rows = rowCount(items); const firstY = (height - (rows - 1) * rowGap) / 2;
    items.forEach((node, index) => out.set(node.id, { x: starts[type] + Math.floor(index / rows) * 150, y: firstY + (index % rows) * rowGap }));
  });
  const lastNicX = starts.nic + (nicColumns - 1) * 150;
  const lastGpuX = starts.gpu + (gpuColumns - 1) * 150;
  const width = Math.max(1100, Math.max(groups.nic.length ? lastNicX : 0, groups.gpu.length ? lastGpuX : 0, 510) + 180);
  return { positions: out, width, height };
}
function ensureLayout() {
  if (!state.positions) { const layoutState = layout(state.data.nodes, state.data.edges); state.positions = layoutState.positions; state.graphWidth = layoutState.width; state.graphHeight = layoutState.height; }
}
function curveFor(edge, positions, edges) {
  const a = positions.get(edge.source), b = positions.get(edge.target); if (!a || !b) return '';
  const siblings = edges.filter((candidate) => candidate.target === edge.target).sort((left, right) => left.source.localeCompare(right.source));
  const slot = siblings.findIndex((candidate) => candidate.source === edge.source);
  const portGap = siblings.length > 1 ? Math.min(9, 36 / (siblings.length - 1)) : 0;
  const targetY = b.y + (slot - (siblings.length - 1) / 2) * portGap;
  const direction = a.x >= b.x ? 1 : -1;
  const sourceX = a.x - direction * 59; const targetX = b.x + direction * 59; const middleX = (sourceX + targetX) / 2;
  return `M ${sourceX} ${a.y} C ${middleX} ${a.y}, ${middleX} ${targetY}, ${targetX} ${targetY}`;
}
function visibleTopology() {
  const children = new Map();
  state.data.edges.forEach((edge) => { if (!children.has(edge.target)) children.set(edge.target, []); children.get(edge.target).push(edge.source); });
  const hidden = new Set();
  const hideDescendants = (id) => (children.get(id) || []).forEach((child) => { if (hidden.has(child)) return; hidden.add(child); hideDescendants(child); });
  state.collapsed.forEach(hideDescendants);
  const nodes = state.data.nodes.filter((node) => !hidden.has(node.id));
  const visibleIds = new Set(nodes.map((node) => node.id));
  const edges = state.data.edges.filter((edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target));
  return { nodes, edges, visibleIds, children };
}
function renderGraph() {
  const graph = $('#graph'); graph.replaceChildren(); const empty = $('#graph-empty'); if (!state.data) { empty.hidden = false; return; } empty.hidden = true;
  ensureLayout(); const positions = state.positions; const graphWidth = state.graphWidth; const graphHeight = state.graphHeight; const width = 118, height = 52;
  graph.setAttribute('viewBox', `0 0 ${graphWidth} ${graphHeight}`); graph.style.minWidth = `${graphWidth}px`; graph.style.height = `${graphHeight}px`;
  const point = (id) => positions.get(id); const viewport = svgEl('g', { class:'viewport', transform:`translate(${state.view.x} ${state.view.y}) scale(${state.view.zoom})` }); graph.append(viewport);
  const visible = visibleTopology();
  visible.edges.forEach((edge) => { const path = curveFor(edge, positions, visible.edges); if (path) viewport.append(svgEl('path', { d:path, class:`graph-link ${edge.kind}` })); });
  const allGpus = state.data.nodes.filter((node) => node.type === 'gpu');
  const gpuLinks = state.data.gpuLinks.map((link) => ({ ...link, sourceId:allGpus[link.source]?.id, targetId:allGpus[link.target]?.id })).filter((link) => visible.visibleIds.has(link.sourceId) && visible.visibleIds.has(link.targetId));
  if (gpuLinks.length <= 80) gpuLinks.forEach((link) => { const a = point(link.sourceId), b = point(link.targetId); if (!a || !b) return; const line = svgEl('line', { x1:a.x, y1:a.y, x2:b.x, y2:b.y, class:'gpu-link' }); viewport.append(line); const text = svgEl('text', { x:(a.x+b.x)/2, y:(a.y+b.y)/2 - 4, class:'edge-label', 'text-anchor':'middle' }); text.textContent = link.label; viewport.append(text); });
  else { const summary = svgEl('text', { x:graphWidth / 2, y:graphHeight - 16, class:'edge-label', 'text-anchor':'middle' }); const types = [...new Set(gpuLinks.map((link) => link.label))].join(', '); summary.textContent = `GPU Link 矩阵：${gpuLinks.length} 条 (${types})，详见下方 mx-smi topo 输出`; viewport.append(summary); }
  visible.nodes.forEach((node) => {
    const p = point(node.id); const childCount = (visible.children.get(node.id) || []).length; const collapsed = state.collapsed.has(node.id);
    const group = svgEl('g', { class:`node ${node.type} ${node.status === 'invalid' ? 'invalid' : ''} ${node.id === state.selected ? 'selected' : ''} ${childCount ? 'has-children' : ''} ${collapsed ? 'collapsed' : ''}`, transform:`translate(${p.x - width/2} ${p.y - height/2})`, tabindex:'0', role:'button', 'data-node-id':node.id, 'aria-label':childCount ? `${node.label}，双击${collapsed ? '展开' : '折叠'} ${childCount} 个下级节点` : node.label });
    if (childCount) group.setAttribute('aria-expanded', String(!collapsed));
    const rect = svgEl('rect', { width, height, rx:2 }); const type = svgEl('text', { x:10, y:16, class:'node-type' }); type.textContent = deviceIcon(node.type); const label = svgEl('text', { x:10, y:31, class:'node-label' }); label.textContent = node.label; const sub = svgEl('text', { x:10, y:44, class:'node-sub' }); sub.textContent = graphMeta(node); const title = svgEl('title'); title.textContent = deviceMeta(node); group.append(rect,type,label,sub,title);
    if (childCount) {
      const toggle = svgEl('g', { class:'node-toggle', tabindex:'0', role:'button', 'aria-label':`${collapsed ? '展开' : '折叠'} ${node.label} 的 ${childCount} 个下级节点` });
      const circle = svgEl('circle', { cx:107, cy:11, r:8 }); const mark = svgEl('text', { x:107, y:14, 'text-anchor':'middle' }); mark.textContent = collapsed ? '+' : '−'; toggle.append(circle, mark); group.append(toggle);
      toggle.addEventListener('pointerdown', (event) => event.stopPropagation());
      toggle.addEventListener('click', (event) => { event.preventDefault(); event.stopPropagation(); if (event.detail <= 1) toggleNode(node.id); });
      toggle.addEventListener('dblclick', (event) => { event.preventDefault(); event.stopPropagation(); });
      toggle.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); toggleNode(node.id); } });
    }
    group.addEventListener('pointerdown', (event) => beginNodeDrag(event, node.id)); group.addEventListener('click', () => selectNode(node.id, false)); group.addEventListener('dblclick', (event) => { event.preventDefault(); event.stopPropagation(); toggleNode(node.id); }); group.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); selectNode(node.id, false); } }); viewport.append(group);
  });
}
function renderOutput() { const text = state.data?.diagnostics?.[state.output] || '尚无输出'; $('#terminal').textContent = text || '目标机器未安装或未找到该工具。'; document.querySelectorAll('.tabs button').forEach((button) => button.classList.toggle('active', button.dataset.output === state.output)); }
function renderAll() { renderHeader(); renderInspection(); renderDevices(); renderDetail(); renderGraph(); renderOutput(); }
function graphPoint(event) { const graph = $('#graph'); const rect = graph.getBoundingClientRect(); return { x:(event.clientX - rect.left) * state.graphWidth / rect.width, y:(event.clientY - rect.top) * state.graphHeight / rect.height }; }
function beginNodeDrag(event, id) { event.stopPropagation(); const point = graphPoint(event); state.gesture = { kind:'node', id, pointerId:event.pointerId, start:point, origin:{ ...state.positions.get(id) }, moved:false }; $('#graph').setPointerCapture?.(event.pointerId); }
function resetView(resetLayout = false) { state.view = { x:0, y:0, zoom:1 }; if (resetLayout) state.positions = null; renderGraph(); }
function setZoom(nextZoom) { if (!state.data) return; const zoom = Math.max(.55, Math.min(2.5, nextZoom)); state.view.zoom = zoom; renderGraph(); }
function bindGraphGestures() { const graph = $('#graph'); graph.addEventListener('wheel', (event) => { if (!state.data) return; event.preventDefault(); const pointer = graphPoint(event); const before = { x:(pointer.x - state.view.x) / state.view.zoom, y:(pointer.y - state.view.y) / state.view.zoom }; const zoom = Math.max(.55, Math.min(2.5, state.view.zoom * (event.deltaY < 0 ? 1.12 : .89))); state.view = { zoom, x:pointer.x - before.x * zoom, y:pointer.y - before.y * zoom }; renderGraph(); }, { passive:false }); graph.addEventListener('pointerdown', (event) => { if (!state.data || event.target.closest?.('.node')) return; const point = graphPoint(event); state.gesture = { kind:'pan', pointerId:event.pointerId, start:point, origin:{ x:state.view.x, y:state.view.y } }; graph.setPointerCapture?.(event.pointerId); }); graph.addEventListener('pointermove', (event) => { const gesture = state.gesture; if (!gesture || gesture.pointerId !== event.pointerId) return; const point = graphPoint(event); if (gesture.kind === 'pan') { state.view.x = gesture.origin.x + point.x - gesture.start.x; state.view.y = gesture.origin.y + point.y - gesture.start.y; } else { const nodePoint = { x:(point.x - state.view.x) / state.view.zoom, y:(point.y - state.view.y) / state.view.zoom }; state.positions.set(gesture.id, nodePoint); gesture.moved = true; } renderGraph(); }); graph.addEventListener('pointerup', () => { state.gesture = null; }); graph.addEventListener('pointercancel', () => { state.gesture = null; }); }
async function readScanResponse(response) {
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('application/x-ndjson')) {
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || '采集失败。');
    return payload;
  }
  if (!response.body) throw new Error('浏览器不支持读取采集进度流。');
  const reader = response.body.getReader(); const decoder = new TextDecoder();
  let buffer = ''; let result = null; let streamError = '';
  const consume = (line) => {
    if (!line.trim()) return;
    const event = JSON.parse(line);
    if (event.type === 'progress') updateProgress(event);
    else if (event.type === 'result') result = event.data;
    else if (event.type === 'error') streamError = event.error || '采集失败。';
  };
  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) { consume(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1); }
    if (done) break;
  }
  if (buffer.trim()) consume(buffer);
  if (streamError) throw new Error(streamError);
  if (!result) throw new Error('采集响应不完整，请重试。');
  return result;
}
async function scan(useRoot = false) {
  setLoading(true, useRoot);
  const passwordInput = $('#password'); const enteredPassword = passwordInput.value;
  const body = { kind: state.kind, profile: $('#profile').value, useRoot };
  if (state.kind === 'remote') Object.assign(body, { host: $('#host').value.trim(), user: $('#user').value.trim(), port: $('#port').value, identityFile: $('#identity-file').value.trim() });
  const password = enteredPassword || (state.kind === 'remote' ? cachedRemotePassword(body) : '');
  $('#scan-note').textContent = useRoot
    ? `正在使用${password ? (enteredPassword ? '密码完成 ' : '已缓存密码完成 ') : '免密 '}root 鉴权并执行只读采集。`
    : `正在执行只读硬件查询${!enteredPassword && password ? '（复用当前页面的 SSH 密码）' : ''}。`;
  if (password && (state.kind === 'remote' || useRoot)) body.password = password;
  const requestBody = JSON.stringify(body); if (body.password) passwordInput.value = '';
  try {
    const response = await fetch('/api/scan', { method:'POST', headers:{ 'Content-Type':'application/json', Accept:'application/x-ndjson' }, body:requestBody });
    const data = await readScanResponse(response);
    if (body.kind === 'remote' && password) rememberRemotePassword(body, password);
    state.data = data; state.selected = data.nodes[0]?.id || null; state.positions = null; state.collapsed = new Set(); state.view = { x:0, y:0, zoom:1 };
    renderAll(); renderTests(true); renderEp(); finishLoading(true);
  } catch (error) { displayError(error.message); finishLoading(false); }
}

function testDefinition(id = state.tests.selected) {
  return TEST_DEFINITIONS.find((item) => item.id === id) || TEST_DEFINITIONS[0];
}

function testStatus(status = 'idle') {
  return ({ idle:'待测试', running:'运行中', passed:'通过', failed:'失败', stopped:'已停止' })[status] || '待测试';
}

function switchPage(page) {
  state.page = page === 'cluster' ? 'cluster' : 'single';
  $('#single-page').hidden = state.page !== 'single';
  $('#cluster-page').hidden = state.page !== 'cluster';
  document.querySelectorAll('.page-tabs button').forEach((button) => {
    const active = button.dataset.page === state.page;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
    button.tabIndex = active ? 0 : -1;
  });
  if (state.page === 'single') {
    switchSingleView(state.singleView);
    if (state.data) renderHeader(); else setTopConnection('', '等待采集');
  } else {
    renderCluster();
    syncClusterConnection();
  }
}

function switchSingleView(view) {
  state.singleView = ['info', 'tests', 'ep'].includes(view) ? view : 'info';
  $('#info-page').hidden = state.singleView !== 'info';
  $('#tests-page').hidden = state.singleView !== 'tests';
  $('#ep-page').hidden = state.singleView !== 'ep';
  document.querySelectorAll('.single-tabs button').forEach((button) => {
    const active = button.dataset.singleView === state.singleView;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
    button.tabIndex = active ? 0 : -1;
  });
  if (state.singleView === 'tests') renderTests();
  if (state.singleView === 'ep') renderEp();
}

function clusterHosts() {
  return $('#cluster-hosts').value.split(/[,，\s]+/).map((host) => host.trim()).filter(Boolean);
}

function clusterStatusLabel(status) {
  return ({ pass:'一致', fail:'不一致', unknown:'数据不足', error:'采集失败', pending:'待采集', running:'采集中', success:'已完成', reference:'参考组' })[status] || status;
}

function setClusterNote(message, type = '') {
  const note = $('#cluster-note');
  note.className = `cluster-note ${type}`.trim();
  note.textContent = message;
}

function updateClusterHostCount() {
  const hosts = clusterHosts();
  const unique = new Set(hosts.map((host) => host.toLowerCase())).size;
  const count = $('#cluster-host-count');
  count.textContent = `${hosts.length} / ${state.cluster.size}`;
  count.classList.toggle('ready', hosts.length === state.cluster.size && unique === hosts.length);
  count.classList.toggle('invalid', hosts.length > 0 && (hosts.length !== state.cluster.size || unique !== hosts.length));
  $('#cluster-host-hint').textContent = unique !== hosts.length
    ? '检测到重复地址，请每台机器只填写一次。'
    : `请输入 ${state.cluster.size} 个不重复的地址，当前 ${hosts.length} 个。`;
}

function renderClusterSummary() {
  const summary = $('#cluster-summary');
  const strong = summary.querySelector('strong');
  const detail = summary.querySelector('span');
  if (state.cluster.running) {
    const completed = [...state.cluster.progress.values()].filter((item) => ['success', 'error'].includes(item.status)).length;
    strong.textContent = `${completed} / ${state.cluster.size} 台已完成`;
    detail.textContent = '正在并行采集各机器硬件信息';
    return;
  }
  const data = state.cluster.data;
  if (!data) {
    strong.textContent = state.cluster.error ? '集群采集失败' : '尚未采集';
    detail.textContent = state.cluster.error || '选择规模并填写机器 IP';
    return;
  }
  strong.textContent = `${data.summary.successful} / ${data.size} 台采集成功`;
  detail.textContent = `${data.summary.passed} / 6 项一致 · ${data.summary.failed} 台失败`;
}

function renderClusterProgress(done = false, failed = false) {
  const progress = $('#cluster-progress');
  const entries = [...state.cluster.progress.values()];
  if (!state.cluster.running && !done && !entries.length) { progress.hidden = true; return; }
    const totalTasks = state.cluster.size * INVENTORY_TASK_COUNT;
    const completedTasks = entries.reduce((sum, item) => sum + Math.min(INVENTORY_TASK_COUNT, item.completed || 0), 0);
  const finishedMachines = entries.filter((item) => ['success', 'error'].includes(item.status)).length;
  const percent = done ? 100 : Math.min(96, Math.round(completedTasks / Math.max(1, totalTasks) * 96));
  progress.hidden = false;
  progress.classList.toggle('complete', done && !failed);
  progress.classList.toggle('error', failed);
  progress.setAttribute('aria-valuenow', String(percent));
  progress.querySelector('.progress-track i').style.width = `${percent}%`;
  $('#cluster-progress-label').textContent = failed
    ? '集群采集失败'
    : done ? `采集完成 · ${finishedMachines}/${state.cluster.size} 台`
      : `${finishedMachines}/${state.cluster.size} 台完成 · ${completedTasks}/${totalTasks} 项任务`;
}

function renderClusterChecks() {
  const container = $('#cluster-checks');
  container.replaceChildren();
  const checks = state.cluster.data?.checks || CLUSTER_CHECK_DEFINITIONS.map((item) => ({ ...item, status:'pending', summary:'采集后进行比对' }));
  checks.forEach((check) => {
    const definition = CLUSTER_CHECK_DEFINITIONS.find((item) => item.id === check.id) || check;
    const card = document.createElement('article');
    card.className = `cluster-check-card ${check.status}`;
    const symbol = document.createElement('span'); symbol.className = 'cluster-check-symbol'; symbol.textContent = definition.symbol;
    const copy = document.createElement('div');
    const title = document.createElement('strong'); title.textContent = check.name || definition.name;
    const message = document.createElement('p'); message.textContent = check.summary;
    copy.append(title, message);
    const status = document.createElement('b'); status.textContent = clusterStatusLabel(check.status);
    card.append(symbol, copy, status);
    container.append(card);
  });
  const passed = checks.filter((check) => check.status === 'pass').length;
  $('#cluster-check-summary').textContent = `${passed} / ${CLUSTER_CHECK_DEFINITIONS.length}`;
}

function clusterNodeSummary(node) {
  if (!node.success) return { status:'error', text:'采集失败' };
  const checks = state.cluster.data?.checks || [];
  const failed = checks.filter((check) => check.status === 'fail').length;
  const incomplete = checks.filter((check) => ['unknown', 'error'].includes(check.status)).length;
  if (failed) return { status:'fail', text:`${failed} 项存在集群差异` };
  if (incomplete) return { status:'unknown', text:`${incomplete} 项无法完成比对` };
  return { status:'pass', text:'6 项配置一致' };
}

function renderClusterMachines() {
  const container = $('#cluster-machines');
  container.replaceChildren();
  const resultNodes = state.cluster.data?.nodes;
  const nodes = resultNodes || clusterHosts().map((host) => ({ host, progress:state.cluster.progress.get(host) }));
  $('#cluster-machine-total').textContent = nodes.length;
  if (!nodes.length) {
    container.append(Object.assign(document.createElement('p'), { className:'empty', textContent:'尚无集群采集结果' }));
    return;
  }
  nodes.forEach((node, index) => {
    const progress = node.progress || state.cluster.progress.get(node.host);
    const resultStatus = resultNodes ? clusterNodeSummary(node) : { status:progress?.status || 'pending', text:progress?.status === 'running' ? (progress.label || '正在采集') : progress?.error || clusterStatusLabel(progress?.status || 'pending') };
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `cluster-machine ${resultStatus.status} ${node.host === state.cluster.selected ? 'selected' : ''}`;
    button.disabled = !resultNodes;
    if (resultNodes) button.addEventListener('click', () => { state.cluster.selected = node.host; renderClusterMachines(); renderClusterDetail(); });
    const order = document.createElement('span'); order.className = 'cluster-machine-index'; order.textContent = String(index + 1).padStart(2, '0');
    const copy = document.createElement('span'); copy.className = 'cluster-machine-copy';
    const host = document.createElement('strong'); host.textContent = node.host;
    const hostname = document.createElement('small'); hostname.textContent = node.success ? `${node.data.hostname} · ${node.data.summary.gpus} GPU · ${node.data.summary.nics} NIC` : (progress?.label || '等待连接');
    copy.append(host, hostname);
    const status = document.createElement('b'); status.className = 'cluster-machine-status'; status.textContent = resultStatus.text;
    button.append(order, copy, status);
    if (!resultNodes) {
      const meter = document.createElement('i');
      meter.style.width = `${Math.round((progress?.completed || 0) / INVENTORY_TASK_COUNT * 100)}%`;
      button.append(meter);
    }
    container.append(button);
  });
}

function machineCheckStatus(check, detail) {
  if (!detail || detail.error) return 'error';
  if (!detail.available) return 'unknown';
  if (check.status === 'pass') return 'pass';
  if (check.status === 'fail') return detail.matchesBaseline ? 'reference' : 'fail';
  return 'unknown';
}

function renderClusterDetail() {
  const container = $('#cluster-detail');
  const openButton = $('#cluster-open-single');
  container.replaceChildren();
  const node = state.cluster.data?.nodes.find((item) => item.host === state.cluster.selected);
  if (!node) {
    $('#cluster-detail-title').textContent = '单机检查结果';
    $('#cluster-detail-caption').textContent = '从左侧选择机器。';
    openButton.hidden = true;
    container.append(Object.assign(document.createElement('p'), { className:'empty', textContent:'采集后可查看每台机器的配置、比对值和基础巡检结果。' }));
    return;
  }
  $('#cluster-detail-title').textContent = node.success ? (node.data.hostname || node.host) : node.host;
  $('#cluster-detail-caption').textContent = node.success ? `${node.host} · 采集于 ${node.data.collectedAt}` : '该机器未完成采集';
  openButton.hidden = !node.success;
  if (!node.success) {
    const error = document.createElement('div'); error.className = 'cluster-node-error';
    const title = document.createElement('strong'); title.textContent = '采集失败';
    const message = document.createElement('p'); message.textContent = node.error || '未知错误';
    error.append(title, message); container.append(error); return;
  }

  const data = node.data;
  const stats = document.createElement('div'); stats.className = 'cluster-node-stats';
  [['NUMA / CPU', data.summary.cpus], ['GPU', data.summary.gpus], ['NIC', data.summary.nics], ['PCIe Switch', data.summary.switches]].forEach(([label, value]) => {
    const item = document.createElement('div'); const strong = document.createElement('strong'); strong.textContent = value; const span = document.createElement('span'); span.textContent = label; item.append(strong, span); stats.append(item);
  });
  container.append(stats);

  const factsSection = document.createElement('section'); factsSection.className = 'cluster-node-section';
  const factsTitle = document.createElement('h3'); factsTitle.textContent = '机器配置';
  const facts = document.createElement('dl'); facts.className = 'cluster-machine-facts';
  addField(facts, '整机型号', data.machine?.productName || '未检测到');
  addField(facts, 'CPU 型号', data.machine?.model || '未检测到');
  addField(facts, 'CPU 规格', `${data.machine?.sockets ?? '?'} 路 · ${data.machine?.coresPerSocket ?? '?'} 核/路 · ${data.machine?.logicalCpus ?? '?'} 逻辑 CPU`);
  addField(facts, '内存容量', data.machine?.memoryKb ? `${Math.round(data.machine.memoryKb / 1024 / 1024)} GiB` : '未检测到');
  addField(facts, '架构', data.machine?.architecture || data.machine?.systemArch || '未检测到', true);
  addField(facts, '操作系统', data.machine?.os || '未检测到');
  addField(facts, '内核', data.machine?.kernel || '未检测到', true);
  addField(facts, 'BIOS', data.machine?.biosVersion || '未检测到', true);
  factsSection.append(factsTitle, facts); container.append(factsSection);

  const comparisonSection = document.createElement('section'); comparisonSection.className = 'cluster-node-section';
  const comparisonTitle = document.createElement('h3'); comparisonTitle.textContent = '六项一致性比对';
  const comparisons = document.createElement('div'); comparisons.className = 'cluster-node-checks';
  (state.cluster.data.checks || []).forEach((check) => {
    const detail = check.details.find((item) => item.host === node.host);
    const statusName = machineCheckStatus(check, detail);
    const row = document.createElement('article'); row.className = `cluster-node-check ${statusName}`;
    const title = document.createElement('strong'); title.textContent = check.name;
    const value = document.createElement('span'); value.textContent = detail?.value || detail?.error || '无数据';
    const badge = document.createElement('b'); badge.textContent = clusterStatusLabel(statusName);
    row.append(title, value, badge); comparisons.append(row);
  });
  comparisonSection.append(comparisonTitle, comparisons); container.append(comparisonSection);

  const localSection = document.createElement('section'); localSection.className = 'cluster-node-section';
  const localTitle = document.createElement('h3'); localTitle.textContent = '该机器基础巡检';
  const localChecks = document.createElement('div'); localChecks.className = 'cluster-local-checks';
  (data.compliance?.checks || []).forEach((check) => {
    const row = document.createElement('article'); row.className = `cluster-local-check ${check.status}`;
    const title = document.createElement('strong'); title.textContent = check.name;
    const value = document.createElement('span'); value.textContent = check.value;
    const badge = document.createElement('b'); badge.textContent = ({ pass:'正常', fail:'异常', warn:'注意', unknown:'待核验' })[check.status] || check.status;
    row.append(title, value, badge); localChecks.append(row);
  });
  localSection.append(localTitle, localChecks); container.append(localSection);
}

function syncClusterConnection() {
  if (state.cluster.running) return setTopConnection('', '集群采集中');
  const data = state.cluster.data;
  if (!data) return setTopConnection(state.cluster.error ? 'error' : '', state.cluster.error ? '集群采集失败' : '等待集群采集');
  const hasIssues = data.summary.failed > 0 || data.summary.issues > 0;
  setTopConnection(hasIssues ? 'error' : 'ready', hasIssues ? `${data.summary.issues} 项需要核对` : '集群配置一致');
}

function renderCluster() {
  updateClusterHostCount();
  renderClusterSummary();
  renderClusterChecks();
  renderClusterMachines();
  renderClusterDetail();
}

function setClusterLoading(value) {
  state.cluster.running = value;
  document.querySelectorAll('#cluster-size button, #cluster-hosts, #cluster-user, #cluster-password, #cluster-port, #cluster-identity-file, #cluster-profile, #cluster-root').forEach((control) => { control.disabled = value; });
  const button = $('#cluster-scan'); button.disabled = value;
  button.querySelector('.spinner').hidden = !value;
  button.querySelector('.button-label').textContent = value ? '集群采集中…' : '开始集群采集';
  renderClusterSummary();
  if (state.page === 'cluster') syncClusterConnection();
}

function handleClusterEvent(event) {
  if (!event.host || !['node-start', 'node-progress', 'node-complete'].includes(event.type)) return;
  const current = state.cluster.progress.get(event.host) || { completed:0, total:INVENTORY_TASK_COUNT, status:'pending', label:'等待连接' };
  if (event.type === 'node-start') Object.assign(current, { status:'running', label:'建立 SSH 连接' });
  if (event.type === 'node-progress') Object.assign(current, { status:'running', completed:event.completed || 0, total:event.total || INVENTORY_TASK_COUNT, label:event.label || '正在采集' });
  if (event.type === 'node-complete') Object.assign(current, { status:event.success ? 'success' : 'error', completed:INVENTORY_TASK_COUNT, total:INVENTORY_TASK_COUNT, label:event.success ? '采集完成' : '采集失败', error:event.error || '' });
  state.cluster.progress.set(event.host, current);
  renderClusterProgress(); renderClusterSummary(); renderClusterMachines();
}

async function readClusterResponse(response) {
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('application/x-ndjson')) {
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || '集群采集失败。');
    return payload;
  }
  if (!response.body) throw new Error('浏览器不支持读取集群采集进度流。');
  const reader = response.body.getReader(); const decoder = new TextDecoder();
  let buffer = ''; let result = null; let streamError = '';
  const consume = (line) => {
    if (!line.trim()) return;
    const event = JSON.parse(line);
    if (event.type === 'result') result = event.data;
    else if (event.type === 'error') streamError = event.error || '集群采集失败。';
    else handleClusterEvent(event);
  };
  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream:!done });
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) { consume(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1); }
    if (done) break;
  }
  if (buffer.trim()) consume(buffer);
  if (streamError) throw new Error(streamError);
  if (!result) throw new Error('集群采集响应不完整，请重试。');
  return result;
}

async function runClusterScan() {
  const hosts = clusterHosts();
  if (hosts.length !== state.cluster.size) return setClusterNote(`当前选择 ${state.cluster.size} 台机器，需要填写 ${state.cluster.size} 个地址。`, 'error');
  if (new Set(hosts.map((host) => host.toLowerCase())).size !== hosts.length) return setClusterNote('IP 地址不能重复。', 'error');
  const passwordInput = $('#cluster-password');
  const body = {
    size:state.cluster.size, hosts, user:$('#cluster-user').value.trim(), password:passwordInput.value,
    port:$('#cluster-port').value, identityFile:$('#cluster-identity-file').value.trim(),
    profile:$('#cluster-profile').value, useRoot:$('#cluster-root').checked
  };
  const requestBody = JSON.stringify(body);
  passwordInput.value = '';
  state.cluster.data = null; state.cluster.selected = null; state.cluster.error = '';
  state.cluster.progress = new Map(hosts.map((host) => [host, { status:'pending', completed:0, total:INVENTORY_TASK_COUNT, label:'等待连接' }]));
  setClusterNote(`正在并行连接 ${hosts.length} 台机器，密码已从页面清空。`);
  setClusterLoading(true); renderCluster(); renderClusterProgress();
  try {
    const response = await fetch('/api/cluster/scan', { method:'POST', headers:{ 'Content-Type':'application/json', Accept:'application/x-ndjson' }, body:requestBody });
    const data = await readClusterResponse(response);
    state.cluster.data = data; state.cluster.error = '';
    state.cluster.selected = data.nodes[0]?.host || null;
    if (body.password) {
      data.nodes.filter((node) => node.success).forEach((node) => rememberRemotePassword({ ...body, host:node.host }, body.password));
    }
    const comparisonIssues = data.checks.filter((check) => check.status !== 'pass').length;
    if (data.summary.failed) setClusterNote(`集群采集完成：${data.summary.successful} 台成功，${data.summary.failed} 台失败；可分别查看原因。`, 'error');
    else setClusterNote(`集群采集完成：${data.summary.passed} 项一致，${comparisonIssues} 项需要核对。`, comparisonIssues ? 'warning' : 'success');
    renderCluster(); renderClusterProgress(true, data.summary.failed > 0);
  } catch (error) {
    state.cluster.error = error.message;
    setClusterNote(error.message, 'error');
    renderClusterProgress(false, true);
  } finally {
    setClusterLoading(false);
    if (state.page === 'cluster') syncClusterConnection();
  }
}

function openClusterNodeInSinglePage() {
  const node = state.cluster.data?.nodes.find((item) => item.host === state.cluster.selected);
  if (!node?.success) return;
  state.data = node.data; state.selected = node.data.nodes[0]?.id || null; state.positions = null; state.collapsed = new Set(); state.view = { x:0, y:0, zoom:1 };
  state.kind = 'remote';
  $('#host').value = node.host;
  $('#user').value = $('#cluster-user').value.trim();
  $('#port').value = $('#cluster-port').value || '22';
  $('#identity-file').value = $('#cluster-identity-file').value.trim();
  $('#profile').value = $('#cluster-profile').value;
  $('#remote-fields').hidden = false;
  document.querySelectorAll('.segmented button').forEach((button) => button.classList.toggle('active', button.dataset.kind === 'remote'));
  switchPage('single'); switchSingleView('info'); renderAll(); renderTests(true); renderEp();
}

function remoteCredentialKey(target) {
  const host = String(target?.host || '').trim().toLowerCase();
  const user = String(target?.user || '').trim();
  const port = String(Number(target?.port) || 22);
  return host ? `${user}\0${host}\0${port}` : '';
}

function rememberRemotePassword(target, password) {
  const key = remoteCredentialKey(target);
  if (!key || !password) return;
  state.auth.remotePasswords.set(key, password);
}

function cachedRemotePassword(target) {
  const key = remoteCredentialKey(target);
  return key ? state.auth.remotePasswords.get(key) || '' : '';
}

function currentTestTarget(includePassword = false, passwordSelector = '#test-password') {
  const target = { kind: state.kind };
  if (state.kind === 'remote') {
    Object.assign(target, {
      host: $('#host').value.trim(), user: $('#user').value.trim(),
      port: $('#port').value || '22', identityFile: $('#identity-file').value.trim()
    });
    if (includePassword) {
      const password = $(passwordSelector)?.value || cachedRemotePassword(target);
      if (password) target.password = password;
    }
  }
  return target;
}

function knownHcas() {
  if (!targetMatchesInventory()) return [];
  const fromNodes = (state.data?.nodes || []).map((node) => node.ib?.hca).filter(Boolean);
  const fromOutput = [...String(state.data?.diagnostics?.ibstat || '').matchAll(/^CA '([^']+)'/gm)].map((match) => match[1]);
  return [...new Set([...fromNodes, ...fromOutput])].sort((a, b) => a.localeCompare(b, 'zh-CN', { numeric:true }));
}

function knownGpuDevices() {
  if (!targetMatchesInventory()) return [];
  let fallbackIndex = 0;
  return (state.data?.nodes || []).filter((node) => node.type === 'gpu').map((node) => {
    const index = Number.isInteger(node.gpuInfo?.index) ? node.gpuInfo.index : fallbackIndex;
    fallbackIndex += 1;
    return { value:String(index), index, node, label:`${node.label}${node.gpuInfo?.model ? ` · ${node.gpuInfo.model}` : ''}` };
  }).sort((a, b) => a.index - b.index);
}

function knownHcaDevices() {
  const nodes = targetMatchesInventory() ? state.data?.nodes || [] : [];
  return knownHcas().map((hca) => {
    const node = nodes.find((candidate) => candidate.type === 'nic' && candidate.ib?.hca === hca) || null;
    const details = [];
    if (node?.net?.name && node.net.name !== hca) details.push(node.net.name);
    if (Number.isInteger(node?.numa) && node.numa >= 0) details.push(`NUMA ${node.numa}`);
    return { value:hca, node, label:[hca, ...details].join(' · ') };
  });
}

function p2pHcaOptionLabel(hca) {
  const node = hca.node;
  const numa = Number.isInteger(node?.numa) && node.numa >= 0 ? `numa${node.numa}` : 'numa?';
  const speedGbps = Number(node?.nicInfo?.speedGbps);
  const speed = Number.isFinite(speedGbps) && speedGbps > 0 ? `${speedGbps}G` : '速率未知';
  const linkState = node?.nicInfo?.isUp
    ? 'up'
    : String(node?.net?.state || node?.ib?.state || 'unknown').toLowerCase();
  return [hca.value, numa, speed, linkState].join(',');
}

function p2pGdrSelection() {
  const gdr = targetMatchesInventory() ? state.data?.compliance?.gdr : null;
  const preferredMode = String(gdr?.preferredMode || '');
  if (preferredMode === 'peermem') {
    return { mode:'peermem', label:'GDR：PEERMEM，不追加 --use_maca_dmabuf' };
  }
  if (preferredMode === 'dmabuf') {
    return { mode:'dmabuf', label:'GDR：DMA-BUF，命令末尾追加 --use_maca_dmabuf' };
  }
  const peerMemReady = gdr?.peerMem?.ready === true || String(gdr?.peerMem?.property || '') === '1';
  if (peerMemReady) return { mode:'peermem', label:'GDR：PEERMEM，不追加 --use_maca_dmabuf' };
  const dmaBufEvidence = gdr?.dmaBuf?.evidence || {};
  const dmaBufReady = gdr?.dmaBuf?.ready === true
    && dmaBufEvidence.perftestDmaBuf === 'yes'
    && (!gdr.dmaBuf.perftestPath || gdr.dmaBuf.perftestPath === IB_WRITE_BW_PATH);
  if (dmaBufReady) return { mode:'dmabuf', label:'GDR：DMA-BUF，命令末尾追加 --use_maca_dmabuf' };
  return { mode:'auto', label:'GDR：采集结果无法确定，将在测试目标中自动检测 DMA-BUF / PEERMEM' };
}

function knownContainers() {
  if (!targetMatchesInventory()) return [];
  return Array.isArray(state.data?.containers?.items) ? state.data.containers.items : [];
}

function knownContainerImages() {
  if (!targetMatchesInventory()) return [];
  return Array.isArray(state.data?.containers?.images) ? state.data.containers.images : [];
}

function selectedTestEnvironment() {
  const option = $('#test-container').selectedOptions[0];
  if (!option?.dataset.environmentKind || !option.dataset.runtime || !option.dataset.resourceId) return null;
  return {
    kind:option.dataset.environmentKind,
    runtime:option.dataset.runtime,
    id:option.dataset.resourceId,
    label:option.dataset.environmentLabel || option.dataset.resourceId.slice(0, 12)
  };
}

function containerRuntimeLabel(runtime) {
  return ({ docker:'Docker', podman:'Podman', nerdctl:'nerdctl' })[runtime] || runtime;
}

function targetMatchesInventory() {
  if (!state.data) return false;
  return state.kind === 'local' ? state.data.source === '本机' : state.data.source === $('#host').value.trim();
}

function renderTestTarget() {
  const target = currentTestTarget();
  const summary = $('.test-target-summary');
  const matched = targetMatchesInventory();
  const reusesPassword = target.kind === 'remote' && Boolean(cachedRemotePassword(target));
  summary.classList.toggle('scanned', matched);
  if (target.kind === 'remote') {
    $('#test-target-name').textContent = target.host ? `${target.user ? `${target.user}@` : ''}${target.host}:${target.port}` : '远程目标未填写';
  } else $('#test-target-name').textContent = '本机';
  const gpuCount = state.data?.summary?.gpus || 0;
  const hcaCount = knownHcas().length;
  const containerCount = knownContainers().length;
  const imageCount = knownContainerImages().length;
  $('#test-target-detail').textContent = matched
    ? `${state.data.hostname} · ${gpuCount} GPU · ${hcaCount} RDMA HCA · ${containerCount} 容器 / ${imageCount} 镜像${reusesPassword ? ' · 已复用 SSH 密码' : ''}`
    : '未采集当前目标，设备选项可能不完整';
}

function populateTestContainerOptions(reset = false) {
  const select = $('#test-container');
  const previous = select.value;
  const hostOption = Object.assign(document.createElement('option'), { value:'', textContent:'宿主机' });
  const containers = knownContainers();
  const images = knownContainerImages();
  const containerOptions = containers.map((container) => {
    const option = document.createElement('option');
    option.value = `container:${container.runtime}:${container.id}`;
    option.textContent = `[${containerRuntimeLabel(container.runtime)}] ${container.name || container.id.slice(0, 12)}${container.image ? ` · ${container.image}` : ''}`;
    option.dataset.environmentKind = 'container';
    option.dataset.runtime = container.runtime;
    option.dataset.resourceId = container.id;
    option.dataset.environmentLabel = container.name || container.id.slice(0, 12);
    return option;
  });
  const imageOptions = images.map((image) => {
    const reference = image.references?.[0] || image.id.slice(0, 19);
    const option = document.createElement('option');
    option.value = `image:${image.runtime}:${image.id}`;
    option.textContent = `[${containerRuntimeLabel(image.runtime)}] ${reference}${image.size ? ` · ${image.size}` : ''}`;
    option.dataset.environmentKind = 'image';
    option.dataset.runtime = image.runtime;
    option.dataset.resourceId = image.id;
    option.dataset.environmentLabel = reference;
    return option;
  });
  const groups = [];
  if (containerOptions.length) {
    const group = document.createElement('optgroup'); group.label = '运行中的容器'; group.append(...containerOptions); groups.push(group);
  }
  if (imageOptions.length) {
    const group = document.createElement('optgroup'); group.label = '本地镜像（启动临时容器）'; group.append(...imageOptions); groups.push(group);
  }
  const options = [...containerOptions, ...imageOptions];
  select.replaceChildren(hostOption, ...groups);
  select.value = !reset && options.some((option) => option.value === previous) ? previous : '';

  const hint = $('#test-container-hint');
  const runtimes = targetMatchesInventory() && Array.isArray(state.data?.containers?.runtimes) ? state.data.containers.runtimes : [];
  if (!targetMatchesInventory()) hint.textContent = '请先采集当前目标，发现运行中的容器和本地镜像后可选择';
  else if (containers.length || images.length) hint.textContent = `发现 ${containers.length} 个运行中容器、${images.length} 个本地镜像；镜像模式会创建 --rm 临时容器`;
  else if (!runtimes.length) hint.textContent = '未检测到 Docker、Podman 或 nerdctl，测试将在宿主机执行';
  else if (!runtimes.some((runtime) => runtime.available)) hint.textContent = '检测到容器运行时，但当前采集用户无权访问或查询失败';
  else hint.textContent = '已检测到容器运行时，当前没有运行中的容器或本地镜像';
}

function populateTestDeviceOptions(reset = false) {
  populateTestContainerOptions(reset);
  const gpuDevices = knownGpuDevices();
  const p2pGpus = gpuDevices.length ? gpuDevices : [
    { value:'0', index:0, node:null, label:'GPU 0' },
    { value:'1', index:1, node:null, label:'GPU 1' }
  ];
  const gpus = gpuDevices.length ? gpuDevices : [p2pGpus[0]];
  const hcaDevices = knownHcaDevices();

  const previousP2pGpuA = $('#test-p2p-gpu-a').value;
  const previousP2pGpuB = $('#test-p2p-gpu-b').value;
  ['a', 'b'].forEach((endpoint) => {
    const select = $(`#test-p2p-gpu-${endpoint}`);
    select.replaceChildren(...p2pGpus.map((gpu) => Object.assign(document.createElement('option'), { value:gpu.value, textContent:gpu.label })));
  });
  $('#test-p2p-gpu-a').value = !reset && p2pGpus.some((gpu) => gpu.value === previousP2pGpuA) ? previousP2pGpuA : p2pGpus[0].value;
  $('#test-p2p-gpu-b').value = !reset && p2pGpus.some((gpu) => gpu.value === previousP2pGpuB)
    ? previousP2pGpuB
    : (p2pGpus[1]?.value || p2pGpus[0].value);
  refreshP2pNicOptions(reset, hcaDevices);

  const gpuOptions = $('#test-gpu-options');
  const hadGpuOptions = Boolean(gpuOptions.querySelector('input'));
  const previousGpus = new Set([...gpuOptions.querySelectorAll('input:checked')].map((input) => input.value));
  const selectDefaults = reset || !hadGpuOptions;
  gpuOptions.replaceChildren(...gpus.map((gpu) => {
    const label = document.createElement('label'); label.className = 'gpu-choice';
    const input = document.createElement('input'); input.type = 'checkbox'; input.value = gpu.value;
    input.checked = selectDefaults || previousGpus.has(gpu.value);
    const text = document.createElement('span'); text.textContent = gpu.label;
    label.append(input, text);
    return label;
  }));
  updateTestGpuSummary();

  const hcaInput = $('#test-hca');
  const previousHca = hcaInput.value;
  const hcas = hcaDevices.map((item) => item.value);
  $('#test-hca-options').replaceChildren(...hcaDevices.map((item) => Object.assign(document.createElement('option'), { value:item.value, label:item.label })));
  if (reset || !previousHca) hcaInput.value = hcas[0] || '';

  const nicOptions = $('#test-nic-options');
  const hadNicOptions = Boolean(nicOptions.querySelector('input'));
  const previousNics = new Set([...nicOptions.querySelectorAll('input:checked')].map((input) => input.value));
  const selectNicDefaults = reset || !hadNicOptions;
  if (hcaDevices.length) {
    nicOptions.replaceChildren(...hcaDevices.map((hca) => {
      const label = document.createElement('label'); label.className = 'gpu-choice nic-choice';
      const input = document.createElement('input'); input.type = 'checkbox'; input.value = hca.value;
      input.checked = selectNicDefaults || previousNics.has(hca.value);
      const text = document.createElement('span'); text.textContent = hca.label;
      label.append(input, text);
      return label;
    }));
  } else {
    nicOptions.replaceChildren(Object.assign(document.createElement('p'), { className:'selector-empty', textContent:'采集拓扑后显示 RDMA HCA' }));
  }
  updateTestNicSummary();
  if (reset && Number(state.data?.summary?.gpus) >= 2) $('#test-gpu-count').value = String(state.data.summary.gpus);
}

function p2pDeviceDistance(gpuValue, nicValue) {
  const unknown = { code:'N/A', detail:'拓扑映射未知', score:9 };
  if (!targetMatchesInventory() || !nicValue) return unknown;
  const measured = (Array.isArray(state.data?.gpuNicDistances) ? state.data.gpuNicDistances : [])
    .find((item) => Number(item.gpu) === Number(gpuValue) && item.nic === nicValue);
  if (measured && ['PIX', 'PXB', 'NODE', 'SYS'].includes(measured.code)) {
    return { code:measured.code, detail:'mx-smi topo -n 距离矩阵', score:{ PIX:0, PXB:1, NODE:2, SYS:3 }[measured.code] };
  }
  const gpuNode = knownGpuDevices().find((item) => item.index === Number(gpuValue))?.node;
  const nicNode = knownHcaDevices().find((item) => item.value === nicValue)?.node;
  if (!gpuNode || !nicNode) return unknown;
  const allNodes = state.data?.nodes || [];
  const nodeById = new Map(allNodes.map((node) => [node.id, node]));
  const parentById = new Map((state.data?.edges || []).map((edge) => [edge.source, edge.target]));
  const pciAncestors = (node) => (Array.isArray(node.chain) ? node.chain : [])
    .filter((bdf) => bdf && bdf !== node.bdf);
  const gpuPciPath = pciAncestors(gpuNode);
  const nicPciPath = pciAncestors(nicNode);
  const nearestCommonPci = [...gpuPciPath].reverse().find((bdf) => nicPciPath.includes(bdf));
  if (nearestCommonPci) {
    const gpuBridgeHops = gpuPciPath.length - gpuPciPath.lastIndexOf(nearestCommonPci) - 1;
    const nicBridgeHops = nicPciPath.length - nicPciPath.lastIndexOf(nearestCommonPci) - 1;
    if (Math.max(gpuBridgeHops, nicBridgeHops) <= 1) {
      return { code:'PIX', detail:`同 PCIe Switch · ${nearestCommonPci}`, score:0 };
    }
    return { code:'PXB', detail:`同 PCIe Root Complex · ${nearestCommonPci}`, score:1 };
  }
  const gpuParent = parentById.get(gpuNode.id);
  const nicParent = parentById.get(nicNode.id);
  if (gpuParent && gpuParent === nicParent && nodeById.get(gpuParent)?.type === 'switch') {
    return { code:'PIX', detail:`同 PCIe Switch · ${nodeById.get(gpuParent).label}`, score:0 };
  }
  const gpuPath = topologyAncestorIds(gpuNode, parentById);
  const nicPath = topologyAncestorIds(nicNode, parentById);
  const commonSwitch = gpuPath.find((id) => nodeById.get(id)?.type === 'switch' && nicPath.includes(id));
  if (commonSwitch) return { code:'PXB', detail:`同级联 PCIe 路径 · ${nodeById.get(commonSwitch).label}`, score:1 };
  const gpuNuma = Number.isInteger(gpuNode.numa) ? gpuNode.numa : -1;
  const nicNuma = Number.isInteger(nicNode.numa) ? nicNode.numa : -1;
  if (Number.isInteger(gpuNuma) && gpuNuma >= 0 && gpuNuma === nicNuma) {
    return { code:'NODE', detail:`同 NUMA ${gpuNuma}`, score:2 };
  }
  if (Number.isInteger(gpuNuma) && gpuNuma >= 0 && Number.isInteger(nicNuma) && nicNuma >= 0) {
    return { code:'SYS', detail:`跨 NUMA ${gpuNuma} ↔ ${nicNuma}`, score:3 };
  }
  return unknown;
}

function fillP2pNicSelect(endpoint, hcaDevices, reset, avoid = '') {
  const select = $(`#test-p2p-nic-${endpoint}`);
  const previous = select.value;
  const gpu = $(`#test-p2p-gpu-${endpoint}`).value;
  const ranked = hcaDevices.map((hca) => ({ hca, distance:p2pDeviceDistance(gpu, hca.value) }))
    .sort((a, b) => a.distance.score - b.distance.score || a.hca.value.localeCompare(b.hca.value, 'zh-CN', { numeric:true }));
  if (!ranked.length) {
    select.replaceChildren(Object.assign(document.createElement('option'), { value:'', textContent:'请先采集 RDMA HCA' }));
    return '';
  }
  select.replaceChildren(...ranked.map(({ hca, distance }) => Object.assign(document.createElement('option'), {
    value:hca.value,
    textContent:p2pHcaOptionLabel(hca),
    title:`与 GPU ${gpu} 的距离：${distance.code} · ${distance.detail}`
  })));
  const preferred = !reset && ranked.some(({ hca }) => hca.value === previous)
    ? previous
    : (ranked.find(({ hca }) => hca.value !== avoid)?.hca.value || ranked[0].hca.value);
  select.value = preferred;
  return preferred;
}

function refreshP2pNicOptions(reset = false, devices = knownHcaDevices()) {
  const nicA = fillP2pNicSelect('a', devices, reset);
  fillP2pNicSelect('b', devices, reset, nicA);
  updateP2pDistanceOutputs();
}

function updateP2pDistanceOutputs() {
  ['a', 'b'].forEach((endpoint) => {
    const distance = p2pDeviceDistance($(`#test-p2p-gpu-${endpoint}`).value, $(`#test-p2p-nic-${endpoint}`).value);
    const output = $(`#test-p2p-distance-${endpoint}`);
    output.textContent = `距离：${distance.code} · ${distance.detail}`;
    output.className = `p2p-distance ${distance.score <= 1 ? 'near' : distance.score <= 3 ? 'far' : ''}`.trim();
  });
  $('#test-p2p-gdr-hint').textContent = `两端通过 localhost 建立连接；${p2pGdrSelection().label}。`;
}

function selectedTestGpus() {
  return [...document.querySelectorAll('#test-gpu-options input:checked')]
    .map((input) => Number(input.value))
    .filter((gpu) => Number.isInteger(gpu));
}

function updateTestGpuSummary() {
  const options = [...document.querySelectorAll('#test-gpu-options input')];
  const selected = options.filter((input) => input.checked).length;
  $('#test-gpu-summary').textContent = `已选 ${selected} / ${options.length} 张`;
}

function setAllTestGpus(checked) {
  document.querySelectorAll('#test-gpu-options input').forEach((input) => { input.checked = checked; });
  updateTestGpuSummary();
  renderTestSelection();
}

function selectedTestNics() {
  return [...document.querySelectorAll('#test-nic-options input:checked')].map((input) => input.value);
}

function updateTestNicSummary() {
  const options = [...document.querySelectorAll('#test-nic-options input')];
  const selected = options.filter((input) => input.checked).length;
  $('#test-nic-summary').textContent = `已选 ${selected} / ${options.length} 个`;
}

function setAllTestNics(checked) {
  document.querySelectorAll('#test-nic-options input').forEach((input) => { input.checked = checked; });
  updateTestNicSummary();
  renderTestSelection();
}

function topologyAncestorIds(node, parentById) {
  const ids = [node.id];
  let current = node.id;
  let guard = 0;
  while (parentById.has(current) && guard++ < 16) {
    current = parentById.get(current);
    if (ids.includes(current)) break;
    ids.push(current);
  }
  return ids;
}

function selectedDeviceRelation(nodes, parentById, nodeById) {
  if (nodes.length < 2) return '关系待补全';
  const paths = nodes.map((node) => topologyAncestorIds(node, parentById));
  const commonSwitch = paths[0].find((id) => nodeById.get(id)?.type === 'switch' && paths.every((path) => path.includes(id)));
  if (commonSwitch) return `同 PCIe Switch · ${nodeById.get(commonSwitch).label}`;
  const numas = [...new Set(nodes.map((node) => node.numa).filter((numa) => Number.isInteger(numa) && numa >= 0))];
  if (numas.length === 1) return `同 NUMA ${numas[0]} · NODE`;
  if (numas.length > 1) return `跨 NUMA ${numas.join(' ↔ ')} · SYS`;
  return 'PCIe 路径待核验';
}

function renderSelectedTopologyGraph(selectedNodes) {
  const svg = $('#test-topology-graph');
  const empty = $('#test-topology-empty');
  svg.replaceChildren();
  if (!selectedNodes.length) {
    svg.hidden = true;
    empty.hidden = false;
    return;
  }
  const allNodes = state.data?.nodes || [];
  const allEdges = state.data?.edges || [];
  const nodeById = new Map(allNodes.map((node) => [node.id, node]));
  const parentById = new Map(allEdges.map((edge) => [edge.source, edge.target]));
  const relevantIds = new Set();
  selectedNodes.forEach((node) => topologyAncestorIds(node, parentById).forEach((id) => relevantIds.add(id)));
  const relevantNodes = allNodes.filter((node) => relevantIds.has(node.id));
  const relevantEdges = allEdges.filter((edge) => relevantIds.has(edge.source) && relevantIds.has(edge.target));
  const typeOrder = { cpu:0, switch:1, gpu:2, nic:3 };
  const groups = Object.fromEntries(['cpu', 'switch', 'gpu', 'nic'].map((type) => [type, relevantNodes.filter((node) => node.type === type).sort((a, b) => a.label.localeCompare(b.label, 'zh-CN', { numeric:true }))]));
  const width = 900;
  const maxRows = Math.max(1, ...Object.values(groups).map((items) => items.length));
  const height = Math.max(180, 54 + maxRows * 62);
  const xByType = { cpu:95, switch:325, gpu:585, nic:805 };
  const positions = new Map();
  Object.entries(groups).forEach(([type, items]) => {
    const gap = height / (items.length + 1);
    items.forEach((node, index) => positions.set(node.id, { x:xByType[type], y:gap * (index + 1) }));
  });
  const edgesLayer = svgEl('g', { class:'test-topology-edges' });
  relevantEdges.forEach((edge) => {
    const source = positions.get(edge.source); const target = positions.get(edge.target);
    if (!source || !target) return;
    const startX = source.x - 76; const endX = target.x + 76; const middleX = (startX + endX) / 2;
    edgesLayer.append(svgEl('path', { d:`M ${startX} ${source.y} C ${middleX} ${source.y}, ${middleX} ${target.y}, ${endX} ${target.y}` }));
  });
  const selectedIds = new Set(selectedNodes.map((node) => node.id));
  const nodesLayer = svgEl('g', { class:'test-topology-nodes' });
  [...relevantNodes].sort((a, b) => typeOrder[a.type] - typeOrder[b.type]).forEach((node) => {
    const position = positions.get(node.id);
    if (!position) return;
    const group = svgEl('g', { class:`test-topology-node ${node.type}${selectedIds.has(node.id) ? ' selected' : ''}`, transform:`translate(${position.x} ${position.y})` });
    group.append(svgEl('rect', { x:-76, y:-21, width:152, height:42, rx:5 }));
    const title = svgEl('text', { class:'test-topology-node-title', x:0, y:-3, 'text-anchor':'middle' });
    title.textContent = node.label.length > 21 ? `${node.label.slice(0, 20)}…` : node.label;
    const meta = svgEl('text', { class:'test-topology-node-meta', x:0, y:12, 'text-anchor':'middle' });
    const metaText = node.type === 'nic' ? (node.ib?.hca || node.bdf) : node.type === 'gpu' ? (node.bdf || '') : node.type === 'switch' ? (node.bdf || '') : `NUMA ${node.numa}`;
    meta.textContent = metaText.length > 24 ? `${metaText.slice(0, 23)}…` : metaText;
    group.append(title, meta); nodesLayer.append(group);
  });
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('aria-label', `所选 ${selectedNodes.length} 个 GPU/网卡设备的 PCIe 拓扑关系`);
  svg.append(edgesLayer, nodesLayer);
  svg.hidden = false;
  empty.hidden = true;
}

function renderTestTopology(definition, params = testParams()) {
  const section = $('#field-test-topology');
  const enabled = definition.fields.includes('topology');
  section.hidden = !enabled;
  if (!enabled) {
    if ($('#test-topology-dialog').open) $('#test-topology-dialog').close();
    return;
  }
  const detail = $('#test-topology-detail');
  const dialogDetail = $('#test-topology-dialog-detail');
  const relation = $('#test-topology-relation');
  const empty = $('#test-topology-empty');
  if (!targetMatchesInventory()) {
    detail.textContent = '当前执行目标尚未采集';
    dialogDetail.textContent = '当前执行目标尚未采集';
    relation.textContent = '待采集'; relation.className = 'unknown';
    empty.textContent = '请先采集当前目标，再选择 GPU 和 RDMA HCA 查看连接关系。';
    renderSelectedTopologyGraph([]);
    return;
  }
  const gpuValues = definition.id === 'nic-p2p' ? [params.gpuA, params.gpuB] : params.gpus;
  const nicValues = definition.id === 'nic-p2p' ? [params.nicA, params.nicB] : params.nics;
  const gpuDevices = knownGpuDevices();
  const hcaDevices = knownHcaDevices();
  const gpuNodes = gpuValues.map((value) => gpuDevices.find((item) => item.index === Number(value))?.node).filter(Boolean);
  const nicNodes = nicValues.map((value) => hcaDevices.find((item) => item.value === value)?.node).filter(Boolean);
  const selectedNodes = [...new Map([...gpuNodes, ...nicNodes].map((node) => [node.id, node])).values()];
  const missingGpuCount = gpuValues.length - gpuNodes.length;
  const missingNicCount = nicValues.filter(Boolean).length - nicNodes.length;
  if (definition.id === 'nic-p2p') {
    const distanceA = p2pDeviceDistance(params.gpuA, params.nicA);
    const distanceB = p2pDeviceDistance(params.gpuB, params.nicB);
    detail.textContent = `A: GPU ${params.gpuA} / ${params.nicA || '未选择'} · B: GPU ${params.gpuB} / ${params.nicB || '未选择'}`;
    dialogDetail.textContent = `端点 A ${distanceA.code}（${distanceA.detail}） · 端点 B ${distanceB.code}（${distanceB.detail}）`;
  } else {
    detail.textContent = `${gpuValues.length} 张 GPU · ${nicValues.length} 个 RDMA HCA`;
    dialogDetail.textContent = detail.textContent;
  }
  if (!gpuValues.length || !nicValues.filter(Boolean).length) {
    relation.textContent = '选择未完成'; relation.className = 'warning';
    empty.textContent = '请至少选择所需的 GPU 和 RDMA HCA。';
  } else if (missingGpuCount || missingNicCount) {
    relation.textContent = '映射不完整'; relation.className = 'warning';
    empty.textContent = `采集结果缺少 ${missingGpuCount ? `${missingGpuCount} 张 GPU` : ''}${missingGpuCount && missingNicCount ? '、' : ''}${missingNicCount ? `${missingNicCount} 个 HCA` : ''} 的 PCIe 映射。`;
  } else {
    const nodeById = new Map((state.data?.nodes || []).map((node) => [node.id, node]));
    const parentById = new Map((state.data?.edges || []).map((edge) => [edge.source, edge.target]));
    if (definition.id === 'nic-p2p') {
      const distanceA = p2pDeviceDistance(params.gpuA, params.nicA);
      const distanceB = p2pDeviceDistance(params.gpuB, params.nicB);
      relation.textContent = `A ${distanceA.code} · B ${distanceB.code}`;
      relation.className = distanceA.score < 9 && distanceB.score < 9 ? 'ready' : 'warning';
    } else {
      relation.textContent = selectedDeviceRelation(selectedNodes, parentById, nodeById);
      relation.className = 'ready';
    }
  }
  renderSelectedTopologyGraph(selectedNodes);
}

function testParams() {
  const environment = selectedTestEnvironment();
  const gdrMode = p2pGdrSelection().mode;
  return {
    gpuA: Number($('#test-p2p-gpu-a').value),
    gpuB: Number($('#test-p2p-gpu-b').value),
    nicA: $('#test-p2p-nic-a').value,
    nicB: $('#test-p2p-nic-b').value,
    gpus: selectedTestGpus(),
    gpuCount: Number($('#test-gpu-count').value || 2),
    nic: $('#test-hca').value.trim(),
    nics: selectedTestNics(),
    transport: $('#test-transport').value,
    gidIndex: Number($('#test-gid').value || 0),
    gdrMode,
    containerRuntime: environment?.kind === 'container' ? environment.runtime : '',
    containerId: environment?.kind === 'container' ? environment.id : '',
    imageRuntime: environment?.kind === 'image' ? environment.runtime : '',
    imageId: environment?.kind === 'image' ? environment.id : ''
  };
}

function testCommandPreview(definition, params = testParams()) {
  const gid = params.transport === 'RoCE' ? ` -x ${params.gidIndex}` : '';
  const gpuRange = params.gpus.length ? params.gpus.join(',') : '<GPU_RANGE>';
  const nicRange = params.nics.length ? params.nics.join(',') : '<HCA_RANGE>';
  const p2pOptions = [params.nicA, params.nicB].some((nic) => String(nic || '').startsWith('metax_rdma_'))
    ? ' --disable_pcie_relaxed --use_old_post_send -n 10 -m 4096'
    : ' -F --report_gbits';
  const p2pGdrOption = params.gdrMode === 'dmabuf' ? ' --use_maca_dmabuf' : '';
  const p2pGdrLabel = params.gdrMode === 'dmabuf'
    ? 'DMA-BUF（追加 --use_maca_dmabuf）'
    : params.gdrMode === 'peermem' ? 'PEERMEM（不追加 --use_maca_dmabuf）' : '运行时自动检测 DMA-BUF / PEERMEM';
  const commands = {
    'gpu-vector-add': `for gpu in ${params.gpus.length ? params.gpus.join(' ') : '<GPU>'}; do MACA_VISIBLE_DEVICES=$gpu vectorAdd; done`,
    'nic-p2p': `GDR: ${p2pGdrLabel}\nserver: ${IB_WRITE_BW_PATH} -a${p2pOptions} -d ${params.nicA || '<HCA_A>'} --use_maca=${Number.isInteger(params.gpuA) ? params.gpuA : '<GPU_A>'}${gid} -p <AUTO_PORT>${p2pGdrOption} &\nclient: ${IB_WRITE_BW_PATH} -a${p2pOptions} -d ${params.nicB || '<HCA_B>'} --use_maca=${Number.isInteger(params.gpuB) ? params.gpuB : '<GPU_B>'}${gid} -p <AUTO_PORT> localhost${p2pGdrOption}`,
    'nic-alltoall': `MACA_VISIBLE_DEVICES=${gpuRange} MCCL_IB_HCA=${nicRange}${params.transport === 'RoCE' ? ` MCCL_IB_GID_INDEX=${params.gidIndex}` : ''} MCCL_IB_DISABLE=0 MCCL_NET_DISABLE_INTRA=0 MCCL_P2P_LEVEL=LOC MCCL_SHM_DISABLE=1 ${MACA_MPIRUN_PATH} -n ${params.gpus.length || '<N>'} ${MCCL_ALLTOALL_PATH}`,
    'host-ibrc': `MCCL_P2P_LEVEL=LOC MCCL_IB_HCA=${params.nic || '<HCA>'} mpirun -n ${params.gpuCount} alltoall_perf`,
    'host-ibgda': `MXSHMEM_DISABLE_P2P=1 MXSHMEM_HCA_LIST=${params.nic || '<HCA>'}:1 python test_internode.py -n ${params.gpuCount}`
  };
  const command = `${MACA_LIBRARY_PATH_PREVIEW}\n${commands[definition.id] || '-'}`;
  const environment = selectedTestEnvironment();
  if (environment?.kind === 'container') return `${environment.runtime} exec -i ${environment.id.slice(0, 12)} bash -s · ${command}`;
  if (environment?.kind === 'image') return `${environment.runtime} run --rm -i [GPU/RDMA/host namespaces/privileged] ${environment.id.slice(0, 19)} bash -s · ${command}`;
  return command;
}

function renderTestCatalog() {
  const container = $('#test-list');
  container.replaceChildren();
  const groups = [...new Set(TEST_DEFINITIONS.map((item) => item.group))];
  groups.forEach((groupName) => {
    const definitions = TEST_DEFINITIONS.filter((item) => item.group === groupName);
    const group = document.createElement('section'); group.className = 'test-group';
    const heading = document.createElement('h3'); heading.className = 'test-group-title'; heading.append(document.createTextNode(groupName));
    const count = document.createElement('span'); count.textContent = `${definitions.length} 项`; heading.append(count);
    const grid = document.createElement('div'); grid.className = 'test-card-grid';
    definitions.forEach((definition) => {
      const result = state.tests.results.get(definition.id) || { status:'idle' };
      const button = document.createElement('button');
      button.type = 'button'; button.dataset.testId = definition.id;
      button.className = `test-card ${definition.kind} ${definition.id === state.tests.selected ? 'active' : ''}`;
      button.disabled = Boolean(state.tests.running || state.ep.running);
      button.setAttribute('aria-pressed', String(definition.id === state.tests.selected));
      const symbol = document.createElement('span'); symbol.className = 'test-card-symbol'; symbol.textContent = definition.symbol;
      const copy = document.createElement('span'); copy.className = 'test-card-copy';
      const title = document.createElement('strong'); title.textContent = definition.title;
      const description = document.createElement('span'); description.textContent = definition.summary; copy.append(title, description);
      const status = document.createElement('span'); status.className = `test-card-status ${result.status}`; status.textContent = testStatus(result.status);
      button.append(symbol, copy, status); grid.append(button);
    });
    group.append(heading, grid); container.append(group);
  });
  const complete = [...state.tests.results.values()].filter((result) => ['passed','failed'].includes(result.status)).length;
  $('#test-complete-count').textContent = `${complete} / ${TEST_DEFINITIONS.length}`;
}

function defaultTestNote(definition) {
  if (!targetMatchesInventory()) return '建议先在“基本信息”页采集当前目标，以自动识别 GPU 和 HCA。';
  if (definition.id === 'nic-p2p') {
    const params = testParams();
    if (knownGpuDevices().length < 2) return 'P2P 本机互测需要至少两张 GPU。';
    if (!knownHcaDevices().length) return 'P2P 本机互测需要至少一个 RDMA HCA。';
    if (params.gpuA === params.gpuB) return '端点 A 和端点 B 必须选择不同 GPU。';
    if (!params.nicA || !params.nicB) return '请分别为两张 GPU 选择 RDMA HCA。';
    return '将在当前目标内自动启动 P2P 服务端，并由另一端通过 localhost 发起测试；两端可使用同一个 RDMA HCA。';
  }
  if (definition.fields.includes('gpus') && !selectedTestGpus().length) return '请至少选择一张 GPU。';
  if (definition.id === 'nic-alltoall' && selectedTestGpus().length < 2) return 'alltoall 至少需要选择两张 GPU。';
  if (definition.fields.includes('hca') && !$('#test-hca').value.trim()) return '未发现 RDMA HCA，请检查 ibstat 或手动输入 HCA 名称。';
  if (definition.fields.includes('nics') && !selectedTestNics().length) return '请至少选择一个 RDMA HCA。';
  if (definition.id === 'nic-alltoall') return '固定使用 RDMA HCA 通路：禁用 PCIe/MetaXLink P2P 与 SHM，并按所选网络类型配置 MCCL。';
  const environment = selectedTestEnvironment();
  if (environment?.kind === 'container') return `测试将在 ${containerRuntimeLabel(environment.runtime)} 容器 ${environment.label} 内执行，请确认 GPU 和 RDMA 设备已映射。`;
  if (environment?.kind === 'image') return `将由镜像 ${environment.label} 创建 privileged 临时容器，测试结束后自动删除。`;
  return '参数由服务端再次校验，实际执行命令以日志为准。';
}

function setTestNote(message, type = '') {
  const note = $('#test-form-note'); note.textContent = message; note.className = `test-form-note ${type}`.trim();
}

function updateTestControls() {
  const running = Boolean(state.tests.running);
  const busy = running || state.ep.running;
  document.querySelectorAll('#tests-page .test-config-grid input, #tests-page .test-config-grid select').forEach((control) => { control.disabled = busy; });
  document.querySelectorAll('#test-gpu-select-all, #test-gpu-clear, #test-nic-select-all, #test-nic-clear').forEach((control) => { control.disabled = busy; });
  $('#test-confirm').disabled = busy;
  $('#run-test').disabled = busy || !$('#test-confirm').checked;
  $('#run-test').textContent = running ? '测试运行中…' : (state.ep.running ? 'EP 测试运行中' : '开始测试');
  $('#stop-test').disabled = !running || !state.tests.runId || state.tests.stopRequested;
}

function renderTestSelection() {
  const definition = testDefinition();
  const result = state.tests.results.get(definition.id) || { status:'idle' };
  $('#selected-test-title').textContent = definition.title;
  $('#selected-test-description').textContent = definition.description;
  const status = $('#selected-test-status'); status.className = `test-status ${result.status}`; status.textContent = testStatus(result.status);
  const fields = new Set(definition.fields);
  ['p2p','gpus','gpu-count','hca','nics','transport','gid'].forEach((name) => {
    const key = name === 'gpu-count' ? 'gpuCount' : name;
    $('#field-test-' + name).hidden = !fields.has(key) || (name === 'gid' && $('#test-transport').value === 'IB');
  });
  $('#test-gpus-legend').textContent = definition.id === 'nic-alltoall' ? 'GPU 范围' : 'GPU 卡选择';
  $('#test-gpus-hint').textContent = definition.id === 'nic-alltoall'
    ? 'alltoall 将仅启动勾选的 GPU，每张 GPU 对应一个 MPI rank'
    : 'vectorAdd 编译一次后，将依次在每张所选 GPU 上运行并汇总结果';
  $('#field-test-password').hidden = state.kind !== 'remote' || Boolean(cachedRemotePassword(currentTestTarget()));
  updateP2pDistanceOutputs();
  const params = testParams();
  $('#test-command-preview').textContent = testCommandPreview(definition, params);
  renderTestTopology(definition, params);
  if (!state.tests.running) setTestNote(defaultTestNote(definition));
  updateTestControls();
}

function renderTests(resetDevices = false) {
  populateTestDeviceOptions(resetDevices);
  renderTestTarget();
  renderTestCatalog();
  renderTestSelection();
}

function resetTestLog(message = '$ 选择测试项并确认性能影响后开始') {
  const terminal = $('#test-terminal');
  const line = document.createElement('span'); line.className = 'log-muted'; line.textContent = message;
  terminal.replaceChildren(line); terminal.dataset.empty = 'true'; terminal.scrollTop = 0;
}

function appendTestLog(text, className = '') {
  if (!text) return;
  const terminal = $('#test-terminal');
  if (terminal.dataset.empty === 'true') { terminal.replaceChildren(); terminal.dataset.empty = 'false'; }
  const line = document.createElement('span'); line.className = className; line.textContent = text; terminal.append(line);
  while (terminal.textContent.length > 1_000_000 && terminal.firstChild) terminal.firstChild.remove();
  terminal.scrollTop = terminal.scrollHeight;
}

function formatDuration(durationMs) {
  if (!Number.isFinite(durationMs)) return '';
  return durationMs < 1000 ? `${durationMs} ms` : `${(durationMs / 1000).toFixed(1)} s`;
}

async function readTestResponse(response) {
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('application/x-ndjson')) {
    let payload = {};
    try { payload = await response.json(); } catch {}
    throw new Error(payload.error || `测试请求失败（HTTP ${response.status}）。`);
  }
  if (!response.body) throw new Error('浏览器不支持读取实时日志。');
  const reader = response.body.getReader(); const decoder = new TextDecoder();
  let buffer = ''; let terminalEvent = null;
  const consume = (line) => {
    if (!line.trim()) return;
    const event = JSON.parse(line);
    if (event.type === 'start') {
      state.tests.runId = event.runId || null;
      $('#test-log-caption').textContent = `${event.label} · 最长 ${event.timeoutSeconds} 秒`;
      $('#test-command-preview').textContent = event.command || $('#test-command-preview').textContent;
      appendTestLog(`$ ${event.command || event.label}\n`, 'log-muted');
      updateTestControls();
    } else if (event.type === 'output') appendTestLog(event.text, event.stream === 'stderr' ? 'log-error' : '');
    else if (event.type === 'result' || event.type === 'error') terminalEvent = event;
  };
  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream:!done });
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) { consume(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1); }
    if (done) break;
  }
  if (buffer.trim()) consume(buffer);
  if (!terminalEvent) throw new Error('测试响应不完整，请重试。');
  return terminalEvent;
}

function validateTestRequest(definition, params, target) {
  if (!$('#test-confirm').checked) return '请先确认 GPU 空闲及性能影响。';
  if (target.kind === 'remote' && !target.host) return '请先在“基本信息”页填写远程地址。';
  if (definition.id === 'nic-p2p') {
    if (!Number.isInteger(params.gpuA) || !Number.isInteger(params.gpuB) || params.gpuA < 0 || params.gpuB < 0) return '请为 P2P 两端分别选择 GPU。';
    if (params.gpuA === params.gpuB) return 'P2P 两端必须选择不同 GPU。';
    if (!params.nicA || !params.nicB) return '请为 P2P 两端分别选择 RDMA HCA。';
  }
  if (definition.fields.includes('gpus') && !params.gpus.length) return '请至少选择一张 GPU。';
  if (definition.id === 'nic-alltoall' && params.gpus.length < 2) return 'alltoall 至少需要选择两张 GPU。';
  if (definition.fields.includes('hca') && !params.nic) return '请选择或输入 RDMA HCA。';
  if (definition.fields.includes('nics') && !params.nics.length) return '请至少选择一个 RDMA HCA。';
  if (definition.fields.includes('gpuCount') && (!Number.isInteger(params.gpuCount) || params.gpuCount < 2)) return 'GPU 数量至少为 2。';
  return '';
}

async function runSelectedTest() {
  if (state.tests.running || state.ep.running) return;
  const definition = testDefinition(); const params = testParams(); const target = currentTestTarget(true);
  const validation = validateTestRequest(definition, params, target);
  if (validation) return setTestNote(validation, 'error');
  const passwordInput = $('#test-password');
  const requestBody = JSON.stringify({ testId:definition.id, confirmed:true, params, target });
  if (target.password) passwordInput.value = '';
  const controller = new AbortController();
  state.tests.controller = controller; state.tests.running = definition.id; state.tests.runId = null;
  state.tests.stopRequested = false; state.tests.stopConfirmed = false; state.tests.stopError = '';
  state.tests.results.set(definition.id, { status:'running', startedAt:Date.now() });
  resetTestLog('');
  appendTestLog(`[目标] ${target.kind === 'remote' ? `${target.user ? `${target.user}@` : ''}${target.host}:${target.port}` : '本机'}\n`, 'log-muted');
  const environment = selectedTestEnvironment();
  const environmentText = environment?.kind === 'container'
    ? `${containerRuntimeLabel(environment.runtime)} 容器 ${environment.label} (${environment.id.slice(0, 12)})`
    : environment?.kind === 'image'
      ? `${containerRuntimeLabel(environment.runtime)} 镜像 ${environment.label}（privileged 临时容器）`
      : '宿主机';
  appendTestLog(`[运行环境] ${environmentText}\n`, 'log-muted');
  renderTests();
  renderEpConfiguration();
  setTestNote('测试已启动，请保持页面连接。');
  let finalNote = ''; let finalNoteType = '';
  try {
    const response = await fetch('/api/tests/run', {
      method:'POST', headers:{ 'Content-Type':'application/json', Accept:'application/x-ndjson' },
      body:requestBody, signal:controller.signal
    });
    const result = await readTestResponse(response);
    if (result.stopped) {
      state.tests.results.set(definition.id, { status:'stopped', durationMs:result.durationMs, detail:result.error });
      appendTestLog(`\n[已停止] ${result.cleanupConfirmed ? '测试程序已确认退出' : result.error || '无法确认测试程序已完全退出'} · ${formatDuration(result.durationMs)}\n`, result.cleanupConfirmed ? 'log-warning' : 'log-error');
      finalNote = result.cleanupConfirmed ? '测试已停止，测试程序已确认退出。' : (result.error || '停止后无法确认测试程序已完全退出。');
      finalNoteType = result.cleanupConfirmed ? 'warning' : 'error';
    } else if (result.type === 'error') {
      state.tests.results.set(definition.id, { status:'failed', durationMs:result.durationMs, detail:result.error });
      appendTestLog(`\n[失败] ${result.error}\n`, 'log-error');
      finalNote = result.error; finalNoteType = 'error';
    } else if (result.success) {
      state.tests.results.set(definition.id, { status:'passed', durationMs:result.durationMs });
      appendTestLog(`\n[通过] 测试完成 · ${formatDuration(result.durationMs)}\n`, 'log-success');
      finalNote = `${definition.title} 测试通过，耗时 ${formatDuration(result.durationMs)}。`; finalNoteType = 'success';
    } else {
      const detail = `进程退出码 ${result.code ?? '-'}${result.signal ? `，信号 ${result.signal}` : ''}`;
      state.tests.results.set(definition.id, { status:'failed', durationMs:result.durationMs, detail });
      appendTestLog(`\n[失败] ${detail} · ${formatDuration(result.durationMs)}\n`, 'log-error');
      finalNote = detail; finalNoteType = 'error';
    }
  } catch (error) {
    if (state.tests.stopRequested || error.name === 'AbortError') {
      state.tests.results.set(definition.id, { status:'stopped', detail:'用户停止' });
      if (state.tests.stopConfirmed) {
        appendTestLog('\n[已停止] 测试程序已确认退出。\n', 'log-warning');
        finalNote = '测试已停止，测试程序已确认退出。';
        finalNoteType = 'warning';
      } else {
        const detail = state.tests.stopError || '停止请求后连接已中断，无法确认测试程序是否已退出。';
        appendTestLog(`\n[停止未确认] ${detail}\n`, 'log-error');
        finalNote = detail;
        finalNoteType = 'error';
      }
    } else {
      state.tests.results.set(definition.id, { status:'failed', detail:error.message });
      appendTestLog(`\n[失败] ${error.message}\n`, 'log-error');
      finalNote = error.message; finalNoteType = 'error';
    }
  } finally {
    state.tests.controller = null; state.tests.running = null; state.tests.runId = null;
    state.tests.stopRequested = false; state.tests.stopConfirmed = false; state.tests.stopError = '';
    $('#test-confirm').checked = false;
    renderTests();
    renderEpConfiguration();
    if (finalNote) setTestNote(finalNote, finalNoteType);
    $('#test-log-caption').textContent = `${definition.title} · ${testStatus(state.tests.results.get(definition.id)?.status)}`;
  }
}

async function requestPerformanceStop(runId) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  let response;
  try {
    response = await fetch('/api/tests/stop', {
      method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ runId }), signal:controller.signal
    });
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('停止确认超过 20 秒，已中断日志连接并继续由服务端清理。');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  let payload = {};
  try { payload = await response.json(); } catch {}
  if (!response.ok) throw new Error(payload.error || `停止请求失败（HTTP ${response.status}）。`);
  if (!payload.confirmed) throw new Error(payload.error || '服务端无法确认测试程序已完全退出。');
  return payload;
}

async function stopTest() {
  const controller = state.tests.controller;
  const runId = state.tests.runId;
  if (!controller || !runId || state.tests.stopRequested) return;
  state.tests.stopRequested = true;
  updateTestControls();
  setTestNote('正在停止测试…');
  appendTestLog('\n[停止] 正在终止测试进程，超时后将强制退出…\n', 'log-warning');
  try {
    await requestPerformanceStop(runId);
    if (state.tests.controller !== controller || state.tests.runId !== runId) return;
    state.tests.stopConfirmed = true;
    appendTestLog('[停止确认] 服务端已确认测试程序退出。\n', 'log-success');
  } catch (error) {
    if (state.tests.controller !== controller || state.tests.runId !== runId) return;
    state.tests.stopError = error.message;
    appendTestLog(`[停止确认失败] ${error.message}\n`, 'log-error');
    setTestNote(error.message, 'error');
    controller.abort();
  }
}

function epOption() {
  return EP_TEST_OPTIONS[$('#ep-test-type').value] || EP_TEST_OPTIONS['low-latency'];
}

function parseEpList(value, allowed, label) {
  const entries = String(value || '').split(/[,，\s]+/).map((item) => item.trim()).filter(Boolean);
  if (!entries.length) return { values:[], error:label + '不能为空。' };
  const values = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) return { values:[], error:label + '只能填写整数并用逗号分隔。' };
    const number = Number(entry);
    if (!allowed.includes(number)) return { values:[], error:label + '仅支持：' + allowed.join(', ') + '。' };
    if (!values.includes(number)) values.push(number);
  }
  return { values, error:'' };
}

function epConfiguration() {
  const testType = $('#ep-test-type').value;
  const option = EP_TEST_OPTIONS[testType] || EP_TEST_OPTIONS['low-latency'];
  const rankResult = parseEpList($('#ep-ranks').value, option.ranks, 'Rank 数量');
  const tokenResult = parseEpList($('#ep-tokens').value, option.tokens, 'Token 数量');
  const hiddenText = $('#ep-hidden').value.trim();
  const hidden = Number(hiddenText);
  const errors = [rankResult.error, tokenResult.error].filter(Boolean);
  if (!/^\d+$/.test(hiddenText) || !Number.isSafeInteger(hidden) || hidden < 256 || hidden > 65536 || hidden % 256 !== 0) {
    errors.push('Hidden Size 必须是 256 到 65536 之间的 256 倍数。');
  }
  const cases = [];
  if (!errors.length) {
    rankResult.values.forEach((rank) => tokenResult.values.forEach((tokens) => cases.push({ rank, tokens, hidden })));
    if (cases.length > 42) errors.push('单次最多运行 42 组参数组合。');
  }
  return {
    testType, option, ranks:rankResult.values, tokens:tokenResult.values,
    hidden, cases, errors
  };
}

function epCommandPreview(config = epConfiguration()) {
  if (config.errors.length || !config.cases.length) return '参数有效后显示执行命令';
  const first = config.cases[0];
  let command;
  if (config.testType === 'low-latency') {
    command = 'bash run.sh ' + first.rank + ' -- --num-tokens ' + first.tokens + ' --hidden ' + first.hidden + ' --warmup 20 --tests 30';
  } else if (config.testType === 'intranode') {
    command = 'bash run_intranode.sh ' + first.rank + ' -- --num-tokens ' + first.tokens + ' --hidden ' + first.hidden;
  } else {
    command = 'bash run_internode.sh -- --num-tokens ' + first.tokens + ' --hidden ' + first.hidden;
  }
  return MACA_LIBRARY_PATH_PREVIEW + '\n' + command + (config.cases.length > 1 ? '  # 共 ' + config.cases.length + ' 组，按顺序执行' : '');
}

function setEpNote(message, type = '') {
  const note = $('#ep-form-note');
  note.textContent = message;
  note.className = ('test-form-note ' + type).trim();
}

function renderEpTarget() {
  const target = currentTestTarget(false, '#ep-password');
  const summary = $('#ep-target-summary');
  const matched = targetMatchesInventory();
  const reusesPassword = target.kind === 'remote' && Boolean(cachedRemotePassword(target));
  summary.classList.toggle('scanned', matched);
  if (target.kind === 'remote') {
    $('#ep-target-name').textContent = target.host ? (target.user ? target.user + '@' : '') + target.host + ':' + target.port : '远程目标未填写';
  } else {
    $('#ep-target-name').textContent = '本机';
  }
  const gpuCount = state.data?.summary?.gpus || 0;
  $('#ep-target-detail').textContent = matched
    ? state.data.hostname + ' · ' + gpuCount + ' GPU' + (reusesPassword ? ' · 已复用 SSH 密码' : '')
    : '未采集当前目标，请手动确认 GPU 数量与 SingleEP 环境';
  $('#field-ep-password').hidden = state.kind !== 'remote' || reusesPassword;
}

function updateEpControls(config = epConfiguration()) {
  const running = state.ep.running;
  const busy = running || Boolean(state.tests.running);
  document.querySelectorAll('#ep-page .ep-config-grid input, #ep-page .ep-config-grid select').forEach((control) => { control.disabled = busy; });
  $('#ep-confirm').disabled = busy;
  $('#run-ep').disabled = busy || config.errors.length > 0 || !$('#ep-confirm').checked;
  $('#run-ep').textContent = running ? '批量测试运行中…' : (state.tests.running ? '基本功能测试运行中' : '开始批量测试');
  $('#stop-ep').disabled = !running || !state.ep.runId || state.ep.stopRequested;
  $('#export-ep-csv').disabled = !state.ep.results.some((result) => result.status !== 'pending' && result.status !== 'running');
}

function renderEpConfiguration() {
  const config = epConfiguration();
  $('#ep-type-hint').textContent = config.option.hint;
  $('#ep-rank-hint').textContent = '可选：' + config.option.ranks.join(', ');
  $('#ep-token-hint').textContent = config.option.label + '：' + config.option.tokens.join(', ');
  $('#ep-combination-count').textContent = config.errors.length ? '参数有误' : config.cases.length + ' 组';
  $('#ep-combination-summary').textContent = config.errors.length
    ? config.errors[0]
    : config.ranks.length + ' Rank × ' + config.tokens.length + ' Token = ' + config.cases.length + ' 组';
  const list = $('#ep-combination-list');
  list.replaceChildren();
  if (config.errors.length) {
    const invalid = document.createElement('span');
    invalid.className = 'invalid';
    invalid.textContent = config.errors[0];
    list.append(invalid);
  } else {
    config.cases.slice(0, 18).forEach((item) => {
      const badge = document.createElement('span');
      badge.textContent = 'r' + item.rank + ' / t' + item.tokens;
      list.append(badge);
    });
    if (config.cases.length > 18) {
      const more = document.createElement('span');
      more.textContent = '+ ' + (config.cases.length - 18) + ' 组';
      list.append(more);
    }
  }
  $('#ep-command-preview').textContent = epCommandPreview(config);
  if (!state.ep.running && config.errors.length) setEpNote(config.errors[0], 'error');
  else if (!state.ep.running && state.ep.status === 'idle') setEpNote('参数会在服务端再次校验；每轮最长 300 秒。');
  updateEpControls(config);
}

function epMetric(value, digits = 2) {
  return Number.isFinite(value) ? Number(value).toFixed(digits) : '-';
}

function epMetricBasis(value) {
  if (value === 'rank-mean') return '跨 Rank 平均';
  if (value === 'rank-max-derived-bandwidth') return '最慢 Rank / 带宽推算';
  if (value === 'rank-max') return '最慢 Rank';
  return '-';
}

function epStatus(status) {
  return ({ pending:'等待', running:'运行中', passed:'通过', failed:'失败', stopped:'已停止' })[status] || status || '等待';
}

function appendEpCell(row, value, className = '', title = '') {
  const cell = document.createElement('td');
  cell.textContent = value;
  if (className) cell.className = className;
  if (title) cell.title = title;
  row.append(cell);
  return cell;
}

function renderEpResults() {
  const body = $('#ep-results-body');
  body.replaceChildren();
  if (!state.ep.results.length) {
    const row = document.createElement('tr');
    const cell = appendEpCell(row, '运行后在此汇总每组参数。', 'ep-empty-row');
    cell.colSpan = 12;
    body.append(row);
  } else {
    state.ep.results.forEach((result) => {
      const metrics = result.metrics || {};
      const row = document.createElement('tr');
      appendEpCell(row, String(result.index ?? '-'));
      appendEpCell(row, result.typeLabel || EP_TEST_OPTIONS[result.testType]?.label || result.testType || '-');
      appendEpCell(row, String(result.rank ?? '-'), 'metric');
      appendEpCell(row, String(result.tokens ?? '-'), 'metric');
      appendEpCell(row, String(result.hidden ?? '-'), 'metric');
      appendEpCell(row, epMetric(metrics.latencyUs), 'metric');
      appendEpCell(row, epMetric(metrics.bandwidthGbps), 'metric');
      appendEpCell(row, epMetric(metrics.dispatchUs), 'metric');
      appendEpCell(row, epMetric(metrics.combineUs), 'metric');
      appendEpCell(row, epMetricBasis(metrics.basis));
      const statusCell = appendEpCell(row, '', 'ep-result-error', result.error || '');
      const status = document.createElement('span');
      status.className = 'ep-result-status ' + (result.status || 'pending');
      status.textContent = epStatus(result.status);
      statusCell.append(status);
      appendEpCell(row, Number.isFinite(result.durationMs) ? formatDuration(result.durationMs) : '-');
      body.append(row);
    });
  }
  const completed = state.ep.results.filter((result) => !['pending', 'running'].includes(result.status));
  const passed = completed.filter((result) => result.status === 'passed').length;
  const failed = completed.filter((result) => ['failed', 'stopped'].includes(result.status)).length;
  const latencies = completed.map((result) => result.metrics?.latencyUs).filter(Number.isFinite);
  const average = latencies.length ? latencies.reduce((sum, value) => sum + value, 0) / latencies.length : null;
  $('#ep-result-total').textContent = String(completed.length);
  $('#ep-result-passed').textContent = String(passed);
  $('#ep-result-failed').textContent = String(failed);
  $('#ep-result-avg').textContent = epMetric(average);
  $('#ep-results-caption').textContent = state.ep.running
    ? '已完成 ' + completed.length + ' / ' + state.ep.total + ' 组，结果实时更新。'
    : completed.length
      ? '共 ' + completed.length + ' 组：' + passed + ' 组通过，' + failed + ' 组失败或停止。'
      : '尚无结果。Low Latency 使用跨 Rank 平均延时；Normal 测试使用最慢 Rank 延时。';
}

function renderEpProgress() {
  const progress = $('#ep-progress');
  const total = Math.max(0, state.ep.total);
  const completed = Math.max(0, state.ep.completed);
  const percent = total ? Math.round((completed / total) * 100) : 0;
  progress.classList.toggle('complete', state.ep.status === 'complete');
  progress.classList.toggle('error', state.ep.status === 'failed' || state.ep.status === 'stopped');
  progress.setAttribute('aria-valuenow', String(percent));
  progress.querySelector('.progress-track i').style.width = percent + '%';
  if (state.ep.running && state.ep.current) {
    $('#ep-progress-label').textContent = '正在运行 ' + state.ep.current.index + '/' + total + ' · r' + state.ep.current.rank + ' / t' + state.ep.current.tokens;
  } else if (state.ep.status === 'complete') {
    $('#ep-progress-label').textContent = '全部完成 · ' + completed + '/' + total;
  } else if (state.ep.status === 'failed') {
    $('#ep-progress-label').textContent = '已结束 · ' + completed + '/' + total;
  } else if (state.ep.status === 'stopped') {
    $('#ep-progress-label').textContent = '已停止 · ' + completed + '/' + total;
  } else {
    $('#ep-progress-label').textContent = '等待开始';
  }
}

function renderEp() {
  renderEpTarget();
  renderEpConfiguration();
  renderEpResults();
  renderEpProgress();
}

function resetEpLog(message = '$ 配置参数并确认性能影响后开始') {
  const terminal = $('#ep-terminal');
  const line = document.createElement('span');
  line.className = 'log-muted';
  line.textContent = message;
  terminal.replaceChildren(line);
  terminal.dataset.empty = 'true';
  terminal.scrollTop = 0;
}

function appendEpLog(text, className = '') {
  if (!text) return;
  const terminal = $('#ep-terminal');
  if (terminal.dataset.empty === 'true') {
    terminal.replaceChildren();
    terminal.dataset.empty = 'false';
  }
  const line = document.createElement('span');
  line.className = className;
  line.textContent = text;
  terminal.append(line);
  while (terminal.textContent.length > 1_000_000 && terminal.firstChild) terminal.firstChild.remove();
  terminal.scrollTop = terminal.scrollHeight;
}

function replaceEpResult(result) {
  const index = state.ep.results.findIndex((item) => item.index === result.index);
  if (index >= 0) state.ep.results[index] = result;
  else state.ep.results.push(result);
  state.ep.results.sort((a, b) => a.index - b.index);
}

function handleEpEvent(event) {
  if (event.type === 'start') {
    state.ep.runId = event.runId || null;
    state.ep.total = event.total;
    $('#ep-log-caption').textContent = event.label + ' · 每轮最长 ' + event.timeoutSeconds + ' 秒';
    appendEpLog('[批次] ' + event.label + '，共 ' + event.total + ' 组\n', 'log-muted');
    updateEpControls();
  } else if (event.type === 'case-start') {
    state.ep.current = event;
    replaceEpResult({
      index:event.index, total:event.total, testType:event.testType, typeLabel:event.typeLabel,
      rank:event.rank, tokens:event.tokens, hidden:event.hidden, status:'running', metrics:{}
    });
    appendEpLog('\n[' + event.index + '/' + event.total + '] $ ' + event.command + '\n', 'log-muted');
    renderEpResults();
    renderEpProgress();
  } else if (event.type === 'output') {
    appendEpLog(event.text, event.stream === 'stderr' ? 'log-error' : '');
  } else if (event.type === 'case-result') {
    replaceEpResult(event.result);
    state.ep.completed = state.ep.results.filter((result) => !['pending', 'running'].includes(result.status)).length;
    state.ep.current = null;
    appendEpLog(
      '\n[' + event.result.index + '/' + event.result.total + '] ' +
      (event.result.success ? 'PASS' : 'FAIL · ' + (event.result.error || '未知错误')) +
      ' · ' + formatDuration(event.result.durationMs) + '\n',
      event.result.success ? 'log-success' : 'log-error'
    );
    renderEpResults();
    renderEpProgress();
  }
}

async function readEpResponse(response) {
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('application/x-ndjson')) {
    let payload = {};
    try { payload = await response.json(); } catch {}
    throw new Error(payload.error || 'EP 测试请求失败（HTTP ' + response.status + '）。');
  }
  if (!response.body) throw new Error('浏览器不支持读取实时日志。');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let terminalEvent = null;
  const consume = (line) => {
    if (!line.trim()) return;
    const event = JSON.parse(line);
    if (event.type === 'result') {
      terminalEvent = event;
      if (Array.isArray(event.results)) state.ep.results = event.results;
      state.ep.completed = Number(event.completed || state.ep.results.length);
      state.ep.current = null;
      renderEpResults();
      renderEpProgress();
    } else {
      handleEpEvent(event);
    }
  };
  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream:!done });
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      consume(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
    }
    if (done) break;
  }
  if (buffer.trim()) consume(buffer);
  if (!terminalEvent) throw new Error('EP 测试响应不完整，请重试。');
  return terminalEvent;
}

function validateEpRequest(config, target) {
  if (config.errors.length) return config.errors[0];
  if (!$('#ep-confirm').checked) return '请先确认 GPU 空闲及性能影响。';
  if (target.kind === 'remote' && !target.host) return '请先在“基本信息”页填写远程地址。';
  const gpuCount = targetMatchesInventory() ? Number(state.data?.summary?.gpus || 0) : 0;
  const maxRanks = config.ranks.length ? Math.max(...config.ranks) : 0;
  if (gpuCount > 0 && maxRanks > gpuCount) return '最大 Rank 数量为 ' + maxRanks + '，但当前采集结果仅发现 ' + gpuCount + ' 张 GPU。';
  return '';
}

async function runSingleEp() {
  if (state.ep.running || state.tests.running) return;
  const config = epConfiguration();
  const target = currentTestTarget(true, '#ep-password');
  const validation = validateEpRequest(config, target);
  if (validation) return setEpNote(validation, 'error');
  const requestBody = JSON.stringify({
    testType:config.testType,
    ranks:config.ranks,
    tokens:config.tokens,
    hidden:config.hidden,
    confirmed:true,
    target
  });
  if (target.password) $('#ep-password').value = '';
  const controller = new AbortController();
  state.ep.controller = controller;
  state.ep.running = true;
  state.ep.runId = null;
  state.ep.stopRequested = false;
  state.ep.stopConfirmed = false;
  state.ep.stopError = '';
  state.ep.total = config.cases.length;
  state.ep.completed = 0;
  state.ep.current = null;
  state.ep.status = 'running';
  state.ep.results = config.cases.map((item, index) => ({
    index:index + 1, total:config.cases.length, testType:config.testType,
    typeLabel:config.option.label, rank:item.rank, tokens:item.tokens,
    hidden:item.hidden, status:'pending', metrics:{}
  }));
  resetEpLog('');
  appendEpLog('[目标] ' + (target.kind === 'remote' ? ((target.user ? target.user + '@' : '') + target.host + ':' + target.port) : '本机') + '\n', 'log-muted');
  setEpNote('批量测试已启动，请保持页面连接。');
  renderEp();
  renderTests();
  let finalMessage = '';
  let finalType = '';
  try {
    const response = await fetch('/api/ep/singleep/run', {
      method:'POST',
      headers:{ 'Content-Type':'application/json', Accept:'application/x-ndjson' },
      body:requestBody,
      signal:controller.signal
    });
    const result = await readEpResponse(response);
    state.ep.status = result.stopped ? 'stopped' : (result.success ? 'complete' : 'failed');
    if (result.stopped) {
      finalMessage = result.cleanupConfirmed
        ? '测试已停止，测试程序已确认退出。'
        : (result.error || '停止已执行，但无法确认测试程序已完全退出。');
      finalType = result.cleanupConfirmed ? 'warning' : 'error';
      appendEpLog('\n[已停止] ' + finalMessage + '\n', result.cleanupConfirmed ? 'log-warning' : 'log-error');
    } else if (result.success) {
      finalMessage = 'SingleEP 批量测试完成：' + result.passed + '/' + result.total + ' 组通过，耗时 ' + formatDuration(result.durationMs) + '。';
      finalType = 'success';
      appendEpLog('\n[完成] ' + finalMessage + '\n', 'log-success');
    } else {
      finalMessage = result.error || ('批量测试完成：' + result.passed + ' 组通过，' + result.failed + ' 组失败。');
      finalType = 'error';
      appendEpLog('\n[完成] ' + finalMessage + '\n', 'log-error');
    }
  } catch (error) {
    if (state.ep.stopRequested || error.name === 'AbortError') {
      state.ep.status = 'stopped';
      state.ep.results = state.ep.results
        .filter((result) => result.status !== 'pending')
        .map((result) => result.status === 'running' ? { ...result, status:'stopped', error:'用户停止' } : result);
      state.ep.completed = state.ep.results.length;
      if (state.ep.stopConfirmed) {
        finalMessage = 'SingleEP 批量测试已停止，测试程序已确认退出。';
        finalType = 'warning';
        appendEpLog('\n[已停止] 测试程序已确认退出。\n', 'log-warning');
      } else {
        finalMessage = state.ep.stopError || '停止请求后连接已中断，无法确认测试程序是否已退出。';
        finalType = 'error';
        appendEpLog('\n[停止未确认] ' + finalMessage + '\n', 'log-error');
      }
    } else {
      state.ep.status = 'failed';
      state.ep.results = state.ep.results
        .filter((result) => result.status !== 'pending')
        .map((result) => result.status === 'running'
          ? { ...result, status:'failed', error:error.message || '连接中断' }
          : result);
      state.ep.completed = state.ep.results.length;
      finalMessage = error.message;
      finalType = 'error';
      appendEpLog('\n[失败] ' + error.message + '\n', 'log-error');
    }
  } finally {
    state.ep.controller = null;
    state.ep.running = false;
    state.ep.runId = null;
    state.ep.stopRequested = false;
    state.ep.stopConfirmed = false;
    state.ep.stopError = '';
    state.ep.current = null;
    $('#ep-confirm').checked = false;
    renderEp();
    renderTests();
    setEpNote(finalMessage, finalType);
    $('#ep-log-caption').textContent = 'SingleEP · ' + (state.ep.status === 'complete' ? '已完成' : state.ep.status === 'stopped' ? '已停止' : '存在失败');
  }
}

async function stopSingleEp() {
  const controller = state.ep.controller;
  const runId = state.ep.runId;
  if (!controller || !runId || state.ep.stopRequested) return;
  state.ep.stopRequested = true;
  updateEpControls();
  setEpNote('正在停止当前测试和剩余组合…');
  appendEpLog('\n[停止] 正在终止当前测试，超时后将强制退出，并取消剩余组合…\n', 'log-warning');
  try {
    await requestPerformanceStop(runId);
    if (state.ep.controller !== controller || state.ep.runId !== runId) return;
    state.ep.stopConfirmed = true;
    appendEpLog('[停止确认] 服务端已确认测试程序退出。\n', 'log-success');
  } catch (error) {
    if (state.ep.controller !== controller || state.ep.runId !== runId) return;
    state.ep.stopError = error.message;
    appendEpLog('[停止确认失败] ' + error.message + '\n', 'log-error');
    setEpNote(error.message, 'error');
    controller.abort();
  }
}

function csvCell(value) {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@]/.test(text)) text = "'" + text;
  return '"' + text.replace(/"/g, '""') + '"';
}

function exportSingleEpCsv() {
  const results = state.ep.results.filter((result) => !['pending', 'running'].includes(result.status));
  if (!results.length) return;
  const header = ['轮次','测试种类','Rank','Token','Hidden','延时_us','带宽_GBps','Dispatch_us','Combine_us','PairMax_us','统计口径','状态','运行耗时_ms','错误'];
  const rows = results.map((result) => {
    const metrics = result.metrics || {};
    return [
      result.index, result.typeLabel || result.testType, result.rank, result.tokens, result.hidden,
      metrics.latencyUs, metrics.bandwidthGbps, metrics.dispatchUs, metrics.combineUs,
      metrics.pairMaxUs, epMetricBasis(metrics.basis), epStatus(result.status),
      result.durationMs, result.error || ''
    ];
  });
  const csv = [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n');
  const blob = new Blob(['\ufeff', csv], { type:'text/csv;charset=utf-8' });
  const link = document.createElement('a');
  const url = URL.createObjectURL(blob);
  link.href = url;
  link.download = 'singleep-results-' + new Date().toISOString().replace(/[:.]/g, '-') + '.csv';
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

document.querySelectorAll('.page-tabs button').forEach((button) => button.addEventListener('click', () => switchPage(button.dataset.page)));
document.querySelectorAll('.single-tabs button').forEach((button) => button.addEventListener('click', () => switchSingleView(button.dataset.singleView)));
$('#go-info').addEventListener('click', () => { switchPage('single'); switchSingleView('info'); });
$('#ep-go-info').addEventListener('click', () => { switchPage('single'); switchSingleView('info'); });
document.querySelectorAll('#cluster-size button').forEach((button) => button.addEventListener('click', () => {
  state.cluster.size = Number(button.dataset.clusterSize);
  state.cluster.data = null; state.cluster.selected = null; state.cluster.error = ''; state.cluster.progress = new Map();
  $('#cluster-progress').hidden = true;
  $('#cluster-progress').classList.remove('complete', 'error');
  document.querySelectorAll('#cluster-size button').forEach((item) => item.classList.toggle('active', item === button));
  setClusterNote('仅执行只读采集；各机器并行连接，单台失败不会中断其他机器。');
  renderCluster();
}));
$('#cluster-hosts').addEventListener('input', () => { updateClusterHostCount(); if (!state.cluster.data) renderClusterMachines(); });
$('#cluster-scan').addEventListener('click', runClusterScan);
$('#cluster-open-single').addEventListener('click', openClusterNodeInSinglePage);
document.querySelectorAll('.segmented button').forEach((button) => button.addEventListener('click', () => {
  state.kind = button.dataset.kind;
  document.querySelectorAll('.segmented button').forEach((item) => item.classList.toggle('active', item === button));
  $('#remote-fields').hidden = state.kind !== 'remote';
  $('#scan-note').textContent = state.kind === 'remote' ? '支持 SSH agent、私钥或密码；连接成功后密码仅在当前页面内复用。' : '本机普通采集无需密码；Root 采集可输入 sudo 密码。';
  populateTestDeviceOptions(true); renderTestTarget(); renderTestSelection(); renderEpTarget(); renderEpConfiguration();
}));
['host','user','port','identity-file'].forEach((id) => $(`#${id}`).addEventListener('input', () => { populateTestDeviceOptions(true); renderTestTarget(); renderTestSelection(); renderEpTarget(); }));
$('#test-list').addEventListener('click', (event) => {
  const card = event.target.closest('[data-test-id]');
  if (!card || state.tests.running || state.ep.running) return;
  state.tests.selected = card.dataset.testId; renderTestCatalog(); renderTestSelection();
});
['test-container','test-gpu-count','test-hca','test-transport','test-gid'].forEach((id) => $(`#${id}`).addEventListener('input', renderTestSelection));
['a', 'b'].forEach((endpoint) => {
  $(`#test-p2p-gpu-${endpoint}`).addEventListener('change', () => { refreshP2pNicOptions(); renderTestSelection(); });
  $(`#test-p2p-nic-${endpoint}`).addEventListener('change', renderTestSelection);
});
$('#test-gpu-options').addEventListener('change', () => { updateTestGpuSummary(); renderTestSelection(); });
$('#test-gpu-select-all').addEventListener('click', () => setAllTestGpus(true));
$('#test-gpu-clear').addEventListener('click', () => setAllTestGpus(false));
$('#test-nic-options').addEventListener('change', () => { updateTestNicSummary(); renderTestSelection(); });
$('#test-nic-select-all').addEventListener('click', () => setAllTestNics(true));
$('#test-nic-clear').addEventListener('click', () => setAllTestNics(false));
$('#open-test-topology').addEventListener('click', () => {
  const dialog = $('#test-topology-dialog');
  if (dialog.open) return;
  if (typeof dialog.showModal === 'function') dialog.showModal();
  else dialog.setAttribute('open', '');
});
$('#close-test-topology').addEventListener('click', () => {
  const dialog = $('#test-topology-dialog');
  if (typeof dialog.close === 'function') dialog.close();
  else dialog.removeAttribute('open');
});
$('#test-topology-dialog').addEventListener('click', (event) => {
  if (event.target !== event.currentTarget) return;
  if (typeof event.currentTarget.close === 'function') event.currentTarget.close();
  else event.currentTarget.removeAttribute('open');
});
$('#test-confirm').addEventListener('change', updateTestControls);
$('#run-test').addEventListener('click', runSelectedTest);
$('#stop-test').addEventListener('click', stopTest);
$('#clear-test-log').addEventListener('click', () => resetTestLog());
$('#ep-test-type').addEventListener('change', () => {
  const option = epOption();
  $('#ep-ranks').value = option.defaultRank;
  $('#ep-tokens').value = option.defaultToken;
  $('#ep-confirm').checked = false;
  state.ep.status = 'idle';
  renderEpConfiguration();
  renderEpProgress();
});
['ep-ranks','ep-tokens','ep-hidden'].forEach((id) => $(`#${id}`).addEventListener('input', () => {
  if (!state.ep.running) state.ep.status = 'idle';
  renderEpConfiguration();
}));
$('#ep-confirm').addEventListener('change', () => updateEpControls());
$('#run-ep').addEventListener('click', runSingleEp);
$('#stop-ep').addEventListener('click', stopSingleEp);
$('#clear-ep-log').addEventListener('click', () => resetEpLog());
$('#export-ep-csv').addEventListener('click', exportSingleEpCsv);
$('#scan').addEventListener('click', () => scan(false));
$('#root-scan').addEventListener('click', () => scan(true));
$('#fit').addEventListener('click', () => resetView(true));
$('#zoom-in').addEventListener('click', () => setZoom(state.view.zoom * 1.2));
$('#zoom-out').addEventListener('click', () => setZoom(state.view.zoom / 1.2));
document.querySelectorAll('.tabs button').forEach((button) => button.addEventListener('click', () => { state.output = button.dataset.output; renderOutput(); }));
bindGraphGestures();
resetTestLog();
resetEpLog();
renderTests();
renderEp();
renderCluster();
