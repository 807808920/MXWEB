

1. 我想要实现一个网页程序实现以下功能：

1.1 机器拓扑展示，主要展示CPU,GPU,PCIE,NIC的连接关系。
1.1.1 支出本机和输入IP地址的远程机器(ssh登录方式)
1.1.2 用图表的方式展示CPU, GPU, NIC, PCIE Switch的连接关系
    - 可以通过mx-smi topo -m, lspci -vvv , ibstat， /opt/maca/bin/macainfo等命令获取拓扑信息和设备信息
    - 可以通过读取/sys/bus/pci/devices/.../numa_node获取NUMA信息
    - 可以通过读取/sys/class/net/.../device/numa_node获取网卡的NUMA信息
    - 可以通过集群部署指南_整理版.md文档获取参考信息

先给个初步，后续需求再添加。


补充需求1：
补充点击节点(cpu,gpu,switch，nic)补充一下信息
- 如果节点不符合集群部署指南内的内容，则节点标红并给出哪几项不符合规定
- 如cpu不是performance模式，NIC ofed版本号不符合要求，网卡固件版本不一致
- 拓扑中支持缩放，节点可以拖动，连线尽量不要重叠
- 左边设备清单设备太多了，应该支持树状折叠

补充需求2：
- 采集拓扑时间有点长，最好加一个进度条，不同的采集任务如果能够并行执行可以加快速度
- 拓扑图前面的层级默认显示尽量靠远一点，这样可以避免节点和连线重叠
- 把logo文字变成Metax Communication Group
- 加入用root权限用户采集按钮，这样直接会用root权限去采集
- /opt/maca/bin/maca_info 改成 /opt/maca/bin/macainfo, 主要采集GPU型号信息


补充需求3：
- 增加密码框，支持输入密码登录和sudo鉴权。
- 拓扑图支持双击点击节点进行 展开/折叠 下一级节点

补充需求4：
- 拓扑图中的节点那个展开/折叠按钮 目前鼠标选不中，需要调整层级，让按钮可以选中。
- 设备清单中的网卡把管理网卡排在前面，并进行颜色标记，其他roce/ib 网卡按照网口速率排序，速率高并且状态up的排在前面，小于100G的网卡标红，显示网卡类型和速率
- GPU 显示GPU型号，HBM大小，频率， PCIE号，GPU使用率
- CPU 显示挂载了几个PCIE switch
- 每个PCIE switch下挂载了几个GPU，几个网卡，显示是单/双上行、上行的速率配置
- 目前root采集按钮，会显示sudo: a password is required采集失败，需要根据密码框的密码进行提取


补充需求5：
- 当前页面作为一个tab页，作为基本信息展示
- 增加基本功能测试tab页
    - 测试项包括：
        - GPU单项
            - GPU vectorAdd测试
            - GPU 带宽测试
            - GPU MetaxLink测试 (alltoall)
            - GPU PCIE测试 (alltoall)
        - 网卡单项
            - 网卡带宽测试 (ibwrite)
            - 网卡时延测试 (ibread_lat)
            - 网卡多流测试 (alltoall)
        - 单机通信测试
            - IBRC测试
            - IBGDA测试


补充需求6：
- 将目前的基本信息和基本功能测试tab页合并为单机检查与测试tab页
- 增加小规模集群检查与测试tab页（2/4/8机器）
- 点击后输入2,4,8机器登录信息。（用户名密码可复用，IP地址输入框，支持输入多个IP，用逗号分隔）
- 检查项包括：
    - 机器配置一致性检查
    - 网卡固件一致性检查
    - 网卡速率一致性检查
    - GPU固件一致性检查
    - GPU型号一致性检查
    - 拓扑一致性检查
- 可单独查看每台机器的检查结果


补充需求7:
- 单机检查与测试中增加EP测试
    - EP测试中分为singleep测试，megakernel测试(先不做，先预留入口)，deepep测试(先不做，先预留入口)
    - 先实现singlep测试，测试参考/home/lchen1/data/projs/llopt/codex/singleep/test/README.md
    - singleep支持 多轮测试，将测试结果汇总成表格，并支持导出csv
    - 测试参数包括：
    - 测试种类3选1， low lantency测试， internode测试， intranode测试
    - rank数量 [1,2,4,8,16,32] 可以支持逗号进行多轮测试
    - hiddensize 默认 7168，可支持配置
    - token数量 [1,2,4,8,16,32,64] for low latency, [128,256,512,1024,2048,4096,8192] for internode/intranode, 可以支持逗号进行多轮测试
    - 测试结果主要关心 平均延时（带宽）