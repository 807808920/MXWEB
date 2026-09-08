const state = { kind: 'local', data: null, selected: null, output: 'gpuTopo', positions: null, collapsed: new Set(), graphWidth: 1320, graphHeight: 600, view: { x: 0, y: 0, zoom: 1 }, gesture: null, progressHideTimer: null };
const $ = (selector) => document.querySelector(selector);
const svgEl = (name, attrs = {}) => { const el = document.createElementNS('http://www.w3.org/2000/svg', name); Object.entries(attrs).forEach(([key, value]) => el.setAttribute(key, value)); return el; };

function deviceIcon(type) { return ({ cpu: 'CPU', gpu: 'GPU', switch: 'SW', nic: 'NIC' })[type] || 'PCI'; }
function pcieSummary(pcie) { return pcie?.speed ? `${pcie.speed} × x${pcie.width || '?'}` : '速率未知'; }
function switchUplinkMode(node) { const count = node.switchInfo?.upstreamCount || 0; return count >= 2 ? '双上行' : count === 1 ? '单上行' : '上行未知'; }
function deviceMeta(node) {
  if (node.type === 'cpu') return `NUMA ${node.numa} · ${node.attachedSwitchCount || 0} 个 PCIe Switch`;
  if (node.type === 'gpu') { const gpu = node.gpuInfo || {}; return `${gpu.model || '型号未知'} · HBM ${gpu.hbmTotal || '未知'} · ${gpu.clock || '频率未知'} · 利用率 ${Number.isFinite(gpu.utilization) ? `${gpu.utilization}%` : '未知'} · ${node.bdf}`; }
  if (node.type === 'switch') return `${node.switchInfo?.gpuCount || 0} GPU · ${node.switchInfo?.nicCount || 0} NIC · ${switchUplinkMode(node)} · ${pcieSummary(node.pcie)}`;
  if (node.type === 'nic') { const nic = node.nicInfo || {}; return `${nic.isManagement ? '管理网 · ' : ''}${nic.transport || 'Ethernet'} · ${nic.speedLabel || '速率未知'} · ${nic.isUp ? 'up' : (node.net?.state || 'unknown')}`; }
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
function updateProgress({ completed = 0, total = 18, label = '准备采集', done = false, error = false }) {
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
  if (value) updateProgress({ completed: 0, total: 18, label: '建立连接' });
}
function finishLoading(success) {
  setLoading(false);
  if (!success) return;
  updateProgress({ completed: 18, total: 18, done: true });
  state.progressHideTimer = setTimeout(() => { $('#scan-progress').hidden = true; }, 1200);
}
function displayError(message) { const target = $('#connection'); target.className = 'connection error'; target.innerHTML = '<i></i>采集失败'; $('#scan-note').textContent = message; updateProgress({ error: true }); }
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
  const issues = data.compliance?.issueCount || 0; const target = $('#connection'); target.className = `connection ${issues ? 'error' : 'ready'}`; target.innerHTML = `<i></i>${issues ? `${issues} 项待处理` : '检查通过'}`;
  const summary = $('#compliance-summary'); summary.className = `compliance-summary ${issues ? 'has-issues' : 'ok'}`; const profile = data.compliance?.profile === 'auto' ? `自动识别为${data.compliance?.detectedProfile === 'virtualized' ? '虚拟化' : '物理机/Docker'}` : (data.compliance?.profile === 'virtualized' ? '虚拟化' : '物理机/Docker'); summary.textContent = `${profile} · ${issues ? `发现 ${issues} 项待处理配置` : '已采集规则均符合'}`;
  $('#scan-note').textContent = '采集完成。未修改目标机器上的任何配置。';
}
function repairFor(title) {
  const fixes = { 'CPU 非 performance 模式':'echo performance | sudo tee /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor', 'PCIe ACS 已开启':'物理机/Docker：关闭 BIOS ACS，并按指南关闭 IOMMU 后重启；虚拟机请确认运行模式。', 'IOMMU 未关闭':'物理机/Docker：检查 /proc/cmdline 与 /sys/class/iommu；按指南关闭后重启。', 'OFED 版本不在已验证范围':'安装项目确认过的 MLNX/DOCA OFED 版本（指南 8.6.1）。', '未检测到 OFED':'安装 OFED 后重新执行 ofed_info -s。', '当前用户不在 video 组':'sudo usermod -aG video <用户名>，重新登录。', '文件描述符上限偏低':'提高 /etc/security/limits.conf 的 nofile，并重新登录。', '同型号网卡固件不一致':'使用供应商或 NVIDIA 固件包，将同 CA type 网卡统一到同一版本。', '计算网卡链路非 Active':'检查网线、交换机端口和 IB/RoCE 模式。', 'PCIe 链路降速':'检查上游 PCIe Switch、插槽和链路训练状态。' }; return fixes[title] || '请结合部署指南对应章节和集群配置进行处理。'; }
function renderInspection() {
  const container = $('#inspection-checks'); container.replaceChildren(); const checks = state.data?.compliance?.checks || []; if (!checks.length) return container.append(Object.assign(document.createElement('p'), { className:'empty', textContent:'采集后显示基础环境检查。' }));
  const counts = { fail:0, warn:0, pass:0, unknown:0 }; checks.forEach((check) => { counts[check.status] = (counts[check.status] || 0) + 1; const item = document.createElement('button'); item.className = `check-item ${check.status}`; item.title = `${check.name}: ${check.value}`; const dot = document.createElement('i'); const name = document.createElement('strong'); name.textContent = check.name; const value = document.createElement('span'); value.textContent = check.value; const status = document.createElement('b'); status.textContent = ({fail:'异常',warn:'注意',pass:'正常',unknown:'待核验'})[check.status]; item.append(dot, name, value, status); container.append(item); }); $('#inspection-total').textContent = `${counts.fail} 异常 · ${counts.warn} 注意 · ${counts.unknown} 待核验`; }
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
    addField(dl, 'Governor', state.data.compliance?.cpuGovernors?.map((item) => `${item.policy}: ${item.mode}`).join(', ') || '未检测到', true);
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
  const passwordInput = $('#password'); const password = passwordInput.value;
  $('#scan-note').textContent = useRoot ? `正在使用${password ? '密码完成 ' : '免密 '}root 鉴权并执行只读采集。` : '正在执行只读硬件查询。';
  const body = { kind: state.kind, profile: $('#profile').value, useRoot };
  if (state.kind === 'remote') Object.assign(body, { host: $('#host').value.trim(), user: $('#user').value.trim(), port: $('#port').value, identityFile: $('#identity-file').value.trim() });
  if (password && (state.kind === 'remote' || useRoot)) body.password = password;
  const requestBody = JSON.stringify(body); if (body.password) passwordInput.value = '';
  try {
    const response = await fetch('/api/scan', { method:'POST', headers:{ 'Content-Type':'application/json', Accept:'application/x-ndjson' }, body:requestBody });
    const data = await readScanResponse(response);
    state.data = data; state.selected = data.nodes[0]?.id || null; state.positions = null; state.collapsed = new Set(); state.view = { x:0, y:0, zoom:1 };
    renderAll(); finishLoading(true);
  } catch (error) { displayError(error.message); finishLoading(false); }
}
document.querySelectorAll('.segmented button').forEach((button) => button.addEventListener('click', () => { state.kind = button.dataset.kind; document.querySelectorAll('.segmented button').forEach((item) => item.classList.toggle('active', item === button)); $('#remote-fields').hidden = state.kind !== 'remote'; $('#scan-note').textContent = state.kind === 'remote' ? '支持 SSH agent、私钥或密码；密码仅用于本次登录/鉴权。' : '本机普通采集无需密码；Root 采集可输入 sudo 密码。'; }));
$('#scan').addEventListener('click', () => scan(false)); $('#root-scan').addEventListener('click', () => scan(true)); $('#fit').addEventListener('click', () => resetView(true)); $('#zoom-in').addEventListener('click', () => setZoom(state.view.zoom * 1.2)); $('#zoom-out').addEventListener('click', () => setZoom(state.view.zoom / 1.2)); document.querySelectorAll('.tabs button').forEach((button) => button.addEventListener('click', () => { state.output = button.dataset.output; renderOutput(); })); bindGraphGestures();
