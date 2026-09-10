# Machine Topology

面向 GPU 服务器的单机与小规模集群检查工具。它以只读命令采集 CPU/NUMA、GPU、NIC 和 PCIe Switch 的关系，并保留原始诊断输出供核对。

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
- MetaX `peer_mem` 属性、KMD DMA-BUF 接口、RDMA 内核接口及 `libibverbs`：GDR 显存注册机制兼容性
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
- DMA-BUF / PEERMEM 的兼容模式及当前驱动链路是否完整（指南 8.5.7、9.3.2.1）

拓扑画布可使用鼠标滚轮缩放、拖动空白处平移、拖动设备节点调整布局；单击 `+`/`−` 按钮，或双击对应的 CPU / PCIe Switch 节点，可展开或折叠其全部下级节点。右上角控件可放大、缩小和恢复自动布局。缺失采集数据会显示为“未检测到”，不会被当作不合规项。

设备清单会把管理网卡置顶并以绿色标记，其余网卡按链路 `up` 状态和速率降序排列；低于 100 Gbps 的非管理 RoCE/IB 网卡显示为红色。设备详情同时展示网卡角色、类型、速率和 IP，GPU 型号、HBM、频率、PCIe 号和使用率，CPU 下挂 PCIe Switch 数，以及每个 Switch 下挂的 GPU/NIC 数量和上行链路配置。

Switch 的单/双上行结论基于当前操作系统可见的 PCIe 父链路；某些硬件的双上行被固件合并或仅记录在机型拓扑配置中时，页面会按“系统可见”结果展示，需结合整机硬件设计核验。

ACS、ATS、RO 和 MRRS 合并为一个 PCIe 控制巡检项，展示各状态的实际数量与 MRRS 取值；配置空间权限不足时会明确提示使用 Root 采集。按指南口径，系统出现多个 `ACSCtl: SrcValid+` 才判定 ACS 已开启，0 或 1 个按关闭处理。物理机/Docker 要求关闭 ACS/IOMMU，虚拟化场景则要求 IOMMU PT、ACS 和上游 ATS；计算网卡 MRRS 大于 256 bytes 会标记异常。PFC/ECN/DSCP 和 GID 仍作为待跨节点/profile 比对的采集证据。

## 小规模集群检查

顶部“小规模集群检查与测试” Tab 支持同时对 2、4 或 8 台远程机器进行只读采集。IP 地址可用逗号、中文逗号或换行分隔；SSH 用户、密码、端口、私钥路径、运行模式和 root 采集选项由全部机器共享。密码在提交请求后立即从页面清空。

各机器并行采集，任何单台失败都不会中断其他机器。采集完成后会比对机器配置、网卡固件、网卡速率、GPU 固件、GPU 型号和规范化后的拓扑结构。可点击每台机器查看六项比对值与它自身的基础巡检结果，也可将该结果打开到单机页查看完整拓扑。

## 基本功能测试

顶部“单机检查与测试”中的“基本功能测试”二级 Tab 提供 9 个受控的测试配方：GPU vectorAdd、GPU 带宽、MetaxLink alltoall、PCIe alltoall、`ib_write_bw`、`ib_read_lat`、网卡多流 alltoall、单机 IBRC 和单机 IBGDA。页面会从最近一次采集结果自动填充 GPU 和 RDMA HCA，并实时显示标准输出、错误输出、退出状态和耗时。

测试服务只接受服务端预定义参数，不接受任意 Shell 命令。每次启动都必须显式确认 GPU 空闲和性能影响；同一服务进程同时只允许一项性能测试。单项有 90–300 秒超时限制，日志上限为 4 MiB；点击停止或关闭页面会终止整个测试进程组。

网卡带宽/时延测试需要在对端先启动对应的 perftest server；网卡多流测试还要求当前目标能通过免密 SSH 访问对端。远程执行沿用单机页“基本信息”中的地址、用户、端口和私钥路径；测试密码需单独输入，提交后立即清空。

## EP 测试

“单机检查与测试”中的“EP 测试”二级 Tab 预留了 SingleEP、MegaKernel 和 DeepEP 三个入口，当前实现 SingleEP。SingleEP 可选择 Low Latency、Intranode 或 Internode，Rank 与 Token 均可用逗号分隔并生成笛卡尔积，多组参数会顺序执行。Hidden Size 默认为 `7168`，允许配置为 `256` 到 `65536` 之间的 `256` 倍数。

- Low Latency：Rank 支持 `1,2,4,8,16,32`，Token 支持 `1,2,4,8,16,32,64`
- Intranode：受参考启动器限制，Rank 支持 `2,4,8`，Token 支持 `128,256,512,1024,2048,4096,8192`
- Internode：按两个连续的 8-rank 逻辑节点运行，Rank 固定为 `16`，Token 支持 `128,256,512,1024,2048,4096,8192`

每轮日志通过 NDJSON 实时返回，表格汇总总延时、Dispatch/Combine 延时、带宽、状态和运行耗时，并可导出带 UTF-8 BOM 的 CSV。Low Latency 展示参考程序输出的跨 Rank 平均延时和 collective effective bandwidth；Intranode/Internode 参考程序只输出最慢 Rank 的 Dispatch/Combine 延时，页面会据此汇总总延时并按实际输出的 Token、Hidden 和 TopK 推算有效带宽，表格和 CSV 中会明确标记统计口径。

默认从 `/home/lchen1/data/projs/llopt/codex/singleep/test` 调用三个白名单启动器；可在启动服务时通过 `SINGLEEP_TEST_DIR=/path/to/singleep/test` 修改服务端及远程目标上的固定目录。每轮最长运行 300 秒，单轮日志上限 2 MiB、整个批次上限 8 MiB；同一服务进程内 EP 与基本功能性能测试互斥。远程执行沿用基本信息页的 SSH 目标，首次主机密钥仍使用 `StrictHostKeyChecking=accept-new` 自动确认。

## 远程 SSH

选择“远程 SSH”后填写地址、用户和端口。认证支持现有 SSH agent、私钥文件路径（例如 `~/.ssh/id_ed25519`）或密码；密码模式要求运行本服务的机器安装 `sshpass`。首次连接会通过 `StrictHostKeyChecking=accept-new` 自动记录新主机密钥；已记录主机的密钥如果发生变化，SSH 仍会拒绝连接。同一个密码同时用于 SSH 和远程 sudo，因此两者应保持一致；直接以 root 登录时不会再调用 sudo。目标机器仅执行上述只读查询，单次采集最长等待 120 秒。

密码会通过 HTTP 请求提交到本服务。跨机器打开页面时，应只在受信网络使用，或在服务前配置 HTTPS 反向代理，避免明文 HTTP 暴露凭据。
