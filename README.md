# Machine Topology

面向 GPU 服务器的本机与远程 SSH 拓扑查看器。它以只读命令采集 CPU/NUMA、GPU、NIC 和 PCIe Switch 的关系，并保留原始诊断输出供核对。

## 启动

```bash
npm start
```

默认监听 `0.0.0.0:4173`，可通过 `http://<服务器 IP>:4173` 从局域网访问。仅需本机访问时可使用：

```bash
HOST=127.0.0.1 npm start
```

该服务可触发目标机器上的 SSH 只读采集，因此应仅在受信任网段开放 `4173/TCP`，并用防火墙或反向代理限制来源地址。

## 采集来源

- `lscpu --json`：CPU 与 NUMA 数量
- `/sys/bus/pci/devices/*`、`lspci`：PCIe 设备、层级关系和设备描述
- `/sys/class/net/*/device/numa_node`：网卡 NUMA 和网口状态
- `mx-smi topo -m`：GPU 链路矩阵
- `ibstat`、`/opt/maca/bin/macainfo`：RDMA 与 MACA/GPU 型号诊断信息
- `ofed_info -s`、`ethtool -i`、PCIe `LnkCap/LnkSta`：OFED、网卡固件和 PCIe 链路检查
- `/proc/cmdline`、`/sys/class/iommu`、PCIe `ACSCtl/ATSCtl/RlxdOrd/MaxReadReq`：虚拟化和 PCIe 控制状态
- `show_gids`、`mlnx_qos`、网卡 ECN sysfs、InfiniBand traffic class：RoCE/GID 配置证据
- `mx-smi -s`、`mx-smi mxlk --show`、`mx-smi --show-pcie`：GPU 版本、MetaxLink、GPU PCIe 状态
- `dmesg`、用户组、`ulimit`、防火墙服务、VSwitch 拓扑文件：系统环境巡检

PCIe Switch 的多个端口会归并到其上游 PEX/PLX Switch，避免把每个 PCI bridge 作为一个图节点。设备未安装 `mx-smi`、`ibstat` 或 `macainfo` 时，其错误文本会出现在诊断区域，不影响其他硬件信息采集。

采集任务会在同一条本机或 SSH 会话内并行读取 CPU、PCIe、NIC/RDMA、RoCE、GPU 和系统诊断，再统一合并结果。页面的单一总体进度条按任务真实完成数更新；拓扑按实际父子层级排列，并使用更宽的层级间距和分离的连线端口，减少初始重叠。

点击“Root 采集”时，本机或远程非 root 账号会通过 `sudo` 提权；已经是 root 的本机进程或远程 root 账号会直接执行。密码框可用于本机 sudo、SSH 密码登录及远程 sudo 鉴权，留空时仍使用 SSH key/agent 和免密 sudo。密码只在本次请求的内存和管道中传递，不写入命令行、日志或采集结果。

## 合规检查与拓扑交互

采集结果依据部署指南标记下列异常；异常节点显示为红色，点击后可查看实测值、原因和对应章节。

- CPU governor 不是 `performance`（指南 3.1.1、9.4）
- Mellanox OFED 未检测到，或不在文档已验证的 `23.10` 至 `25.10` 范围（指南 8.6.1）
- 同一 RDMA CA type 的网卡固件版本不一致（指南 4.3.1）
- 高速计算网卡不是 `Active`（指南 4.5）
- GPU、NIC 或 PCIe Switch 的当前 PCIe 速率/宽度低于其链路能力（指南 9.2.3、11.3）
- 物理机模式下 ACS/IOMMU、用户 `video` 组、文件描述符上限、GPU 数量/VBIOS/MACA/KMD、VSwitch 拓扑文件
- PCIe 的 ATS、Relaxed Ordering、MRRS，以及网卡 PFC/ECN/DSCP、GID 等实测证据

拓扑画布可使用鼠标滚轮缩放、拖动空白处平移、拖动设备节点调整布局；单击 `+`/`−` 按钮，或双击对应的 CPU / PCIe Switch 节点，可展开或折叠其全部下级节点。右上角控件可放大、缩小和恢复自动布局。缺失采集数据会显示为“未检测到”，不会被当作不合规项。

设备清单会把管理网卡置顶并以绿色标记，其余网卡按链路 `up` 状态和速率降序排列；低于 100 Gbps 的非管理 RoCE/IB 网卡显示为红色。设备详情同时展示网卡角色、类型、速率和 IP，GPU 型号、HBM、频率、PCIe 号和使用率，CPU 下挂 PCIe Switch 数，以及每个 Switch 下挂的 GPU/NIC 数量和上行链路配置。

Switch 的单/双上行结论基于当前操作系统可见的 PCIe 父链路；某些硬件的双上行被固件合并或仅记录在机型拓扑配置中时，页面会按“系统可见”结果展示，需结合整机硬件设计核验。

ACS、PCIe 控制寄存器和 `dmesg` 在没有足够权限时显示为“待核验”。指南要求物理机/Docker 关闭 ACS/IOMMU，虚拟化场景则要求 IOMMU PT、ACS 和上游 ATS，系统不会在未选择虚拟化模式时把所有 ACS 状态一律判为异常。PFC/ECN/DSCP、GID 和 MRRS 没有脱离具体集群 profile 的统一阈值，当前展示证据并标记为待跨节点/profile 比对。

## 远程 SSH

选择“远程 SSH”后填写地址、用户和端口。认证支持现有 SSH agent、私钥文件路径（例如 `~/.ssh/id_ed25519`）或密码；密码模式要求运行本服务的机器安装 `sshpass`。同一个密码同时用于 SSH 和远程 sudo，因此两者应保持一致；直接以 root 登录时不会再调用 sudo。目标机器仅执行上述只读查询，单次采集最长等待 120 秒。

密码会通过 HTTP 请求提交到本服务。跨机器打开页面时，应只在受信网络使用，或在服务前配置 HTTPS 反向代理，避免明文 HTTP 暴露凭据。
