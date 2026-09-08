
  第一优先级，纯只读巡检：

  - ACS、IOMMU、ATS、RO、MRRS、VSwitch
  - GPU 数量、VBIOS、MACA/KMD、MetaxLink 健康度
  - NIC 的 IP/MTU/GID/PFC/ECN/DSCP/QoS、驱动/固件/OFED
  - 用户组、SSH 可达性、OS/内核、ulimit、dmesg
  - 在节点详情中展示“检测值、预期值、指南章节、修复命令”

  第二优先级，集群视图：

  - 多 IP 批量 SSH 采集
  - 首台机器或配置文件作为基线
  - GPU/NIC/SDK/固件/内核等跨节点差异矩阵
  - 计算网卡与 GPU/NUMA 绑定关系、拓扑对比

  第三优先级，受控任务中心：

  - 运行 inspector 或单项 ping、ib_write、P2P、MCCL 测试
  - 显示排队、执行日志、带宽阈值、结果历史
  - 执行前检查 GPU 空闲、目标主机、用户权限，并要求显式确认

  交换机、BMC/BIOS 设置无法仅靠当前主机 SSH 完整验证，应后续以交换机 SSH/API、Redfish/BMC 作为独立连接器接入。