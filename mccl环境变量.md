

说明：本文档存在敏感信息，只限于沐曦内部使用，如需发布给外部客户，请通过FAE和商务渠道发布。

本文档包含了常用的通信库环境变量使用说明，使用上针对maca sdk release2.25.2.10及以后的版本。
CUDA生态的NCCL环境变量数量较多，为保持兼容性，MCCL支持对应的环境变量，由于每个环境变量都有其特定的使用场景，使用前请明确其作用及影响。

常规情况下，使用MCCL不需要设置环境变量。如C500/C550等X86机型。另在多机场景有指定特定网卡需求时需设置对应环境变量。

由于沐曦GPU型号、服务器类型及集群拓扑类型较多，网络环境多样复杂，一些特定场景需要设置专门的环境变量，请参照第一章节。
一、MCCL特定场景环境变量
下述场景，需要单独设置一些环境变量来满足特定需求。
1.1 多机环境
集群多机网络如是常规配置，通常也不需要配置网络相关的环境变量。为了屏蔽网络设置差异，或者满足个性化网络需求，可以设置如下环境变量简化配置，保障多机正常运行。
export MCCL_IB_HCA=mlx5_0,mlx5_1（可用的计算网卡网口，不包括存储网卡网口）
export MCCL_CROSS_NIC=1
更多的网络配置可参考《集群部署指南》。
1.2 ARM服务器
1、Cascade拓扑（天固服务器）：export MACA_VISIBLE_DEVICES=0,1,6,7,2,3,4,5
2、Balance topo单机内使用网卡做8卡通信：export MCCL_SHM_DISABLE=1
3、2.22.0.* 及更早期版本，更改ARM buffer size来提升性能：export MCCL_BUFFSIZE=8388608
4、如果通过numa node绑核来提高性能，需要设置：export MCCL_IGNORE_CPU_AFFINITY=1
1.3 异构集群
1、Metax和其他厂商的计算GPU构建异构集群：export MCCL_EXT_CCL_ENABLE=1
2、指定异构插件：export MCCL_HC_PLUGIN=${your_plugin_dynamic_library_path}
3、2.14和2.16版本异构插件必须另外设置如下三个环境变量（2.20版本异构插件不需要设置）
export NCCL_BUFFSIZE=8388608 
export NCCL_ALGO=Ring
export NCCL_PROTO=Simple
1.4 虚拟化场景
1、export MCCL_PCIE_BUFFER_MODE=0，关闭PCIE，开启虚机需要开启ACS，会导致PCIE P2P性能变差。
2、export MACA_EXT_CPU_THREAD_POLICY=2，强制UMD使用polling模式，降低小数据量的通信时延，CPU性能强的情况下，可以置为3。
3、export MCCL_TOPO_FILE=path/topo.xml，来指定特定拓扑信息。（具体xml信息请联系通信库团队获取）
1.5 特定机型
1、超节点机型：软件方式开关C500X Switch/C550 DF机型的机外互联，可使用环境变量MCCL_DISABLE_OPTIC_LINK，详见下文说明。
2、C550 OAM单机8网卡：多机集合运算达到性能最优，需设置MCCL_RINGS="N0 0 1 3 6 2 7 5 4 N4 | N1 1 2 4 7 3 0 6 5 N5 | N2 2 3 5 0 4 1 7 6 N6 | N3 3 4 6 1 5 2 0 7 N7 | N4 4 5 7 2 6 3 1 0 N0 | N5 5 6 0 3 7 4 2 1 N1 | N6 6 7 1 4 0 5 3 2 N2 | N7 7 0 2 5 1 6 4 3 N3"
3、C500单机16卡的机型需设置MCCL_RING_16P1H=1、MCCL_P2P_LEVEL=SYS
4、腾讯C550机型需要设置MCCL_DISABLE_P2P_INTER=1
5、特殊机型MACA_VISIBLE_DEVICES 推荐说明：
服务器类型
场景
收益
VISIBLE序列(MACA_VISIBLE_DEVICES)
阡视服务器
提升性能
性能最佳
0,1,8,9,2,3,10,11,4,5,12,13,6,7,14,15
C600 OAM机型
提升性能
性能最佳
0,4,8,12,6,2,10,14,1,5,9,13,7,3,11,15
C588 Intel机型
优先使用
性能最佳
0,1,2,3,6,5,4,7,10,9,8,11,14,15,12,13

TP8DP2
硬件限制


TP4DP4/PP4
硬件限制
0,1,2,3,6,5,4,7,10,11,8,9,14,13,12,15

TP2EP8
硬件限制
0,10,1,9,2,8,3,11,6,14,7,13,4,12,5,15

TP2DP8
N/A
默认顺序

TP16
N/A
默认顺序 或 任意顺序
C588 海光机型
优先使用
性能最佳
0,1,6,7,2,5,4,3,10,9,8,11,12,13,14,15

TP8DP2
硬件限制


TP4DP4/PP4
硬件限制
0,1,6,7,2,5,4,3,10,11,8,9,12,15,14,13

TP2EP8
硬件限制
0,10,1,9,6,8,7,11,2,12,3,15,4,14,5,13

TP2DP8
N/A
默认顺序

TP16
N/A
默认顺序 或 任意顺序
1.6 极致通信性能
可设置如下环境变量来提升通信性能，在单独评测GPU通信性能时可使用，但同时会有负面影响，在大模型及其他场景中使用需要做专业权衡，谨慎使用。
1、export MACA_EXT_CPU_THREAD_POLICY=2，UMD环境变量，用来降低通信的CPU时延，但会增加CPU负载。

2、export MCCL_FAST_WRITE_BACK=1，提升MCCL使用Cache的性能，该环境变量会修改寄存器，降低HBM速率，也会同时对blas kernel产生性能影响。需要规范使用，保证调用通信库接口的进程正常结束，如遇异常退出或者手动结束（如Ctrl + C），后续使用需要重启机器或者reset GPU。

3、export MCCL_EARLY_WRITE_BACK=15，提升MCCL使用Cache的性能，该环境变量会修改寄存器，降低HBM速率，也会同时对blas kernel产生性能影响。需要规范使用，保证调用通信库接口的进程正常结束，如遇异常退出或者手动结束（如Ctrl + C），后续使用需要重启机器或者reset GPU。

4、export MACA_LAUNCH_MODE=1，UMD环境变量，可降低GPU计算时延，取消GPU任务完成后不必要的刷L2缓存行为，对小size kernel时延约1us优化。
1.7 大模型通信日志
获取大模型的通信行为日志，需设置：
export MCCL_DEBUG=TRACE
export MCCL_DEBUG_SUBSYS=^ALLOC
1.8 历史版本问题
1、2.25.2.0前的maca sdk版本，支持集群all to all运算，需要置如下环境变量：
export MCCL_P2P_NCHANNELS=64
export MCCL_P2P_NCHANNELS_PEER=1
2、2.25.2.10前的maca sdk版本，在C500 PCIE机型上，如果要提升8卡通信性能，需要置如下环境变量：
export MCCL_P2P_LEVEL=SYS
3、2.25.2.12前的maca sdk版本，由于OAM 2.0的AER问题，需要关闭PCIE通信链路和开启GDR。
        export MCCL_PCIE_BUFFER_MODE=0
export MCCL_NET_GDR_LEVEL=SYS
4、2.29.0.0前的maca版本，默认关闭mccl test的all to all优化，即MCCL_OPTIMIZATION_A2A默认值为0。
二、MCCL环境变量说明
2.1 功能相关
2.1.1 MCCL_DISABLE_OPTIC_LINK
描述：C500X/C550 DF拓扑，每个GPU外出2个或3个端口Metaxlink，物理上在机外通过光纤或电缆，直连或者经Switch连接，这些Metaxlink链路称为DF Metaxlink，该环境变量提供软件方式控制所有DF Metaxlink通信的功能（不论该DF Metaxlink作用于机内通信还是机间通信）。在DF Metaxlik training成功后使用，通信效果和不training一致，相当于作为普通的C500/C550集群来使用。关闭DF Metaxlink通信时，需与环境变量MCCL_USE_MXSML_LIB=0组合使用，否则不生效。
可选值：
0  开启DF Metaxlink通信
1  关闭DF Metaxlink通信
默认值：0
2.1.2 MCCL_DISABLE_MULTI_NODE_FABRIC
描述：是否使用Switch链路及机间DF Metaxlink链路，不控制作用于机内的非经Switch的DF Metaxlink链路。注意和MCCL_DISABLE_OPTIC_LINK的区别。
可选值：
0 使用Switch和机间DF Metaxlink通信
1 不使用Switch和机间DF Metaxlink通信
默认值：0
MCCL_DISABLE_OPTIC_LINK 与 MCCL_DISABLE_MULTI_NODE_FABRIC 在各超节点作用范围


拓扑类型
MCCL_DISABLE_OPTIC_LINK=1
MCCL_DISABLE_MULTI_NODE_FABRIC=1
仪电DF 一期/二期
禁用机内及机间DF Metaxlink
禁用机间DF Metaxlink
SH Cube
禁用机间DF Metaxlink，禁用机内metaxlink port 7端口
禁用机间DF Metaxlink
浪潮3D Mesh
不支持，不建议设置
禁用机间retimer连接
C588直连超节点
不支持，不建议设置
禁用机间retimer连接
2.1.3 MCCL_FAST_WRITE_BACK
描述：用于mccl memory barrier时是否启用快速回写cacheline的功能
可选值：
-2  不启用
其他值  启用
默认值：-2
2.1.4 MCCL_EARLY_WRITE_BACK
描述：l2c时 回写的阈值设置，超过阈值时才进行回写
可选值：
-2  不启用回写
其他值 数据超过此值时进行回写
默认值：-2
2.1.5 MCCL_GROUP_WRITE_BACK
描述：是否启用channel 分组功能，同组的channel只做一次memory barrier
可选值：
       -1  自动检测
0  不启用
1  启用
默认值：-1
2.1.6 MCCL_BUFFSIZE
描述：MCCL_BUFFSIZE变量控制MCCL在GPU对之间传输数据时使用的缓冲区大小，对应simple协议。如果您在使用MCCL时遇到内存限制问题，或者您认为不同的缓冲区大小可以提高性能，请使用此变量。
可选值：
使用整数值，建议使用2的幂
默认值：8388608 (8 MB)
2.1.7 MCCL_DISABLE_CACHEABLE_BUFFER
描述：是否使用rwk buffer
可选值：
0  使用rwk buffer
1  不使用rwk buffer
默认值：0
2.1.8 MCCL_THRESHOLD_TO_USE_CACHEABLE_BUFFER
描述：simple模式下使用rwk buffer的阈值，大于此值时使用rwk buffer
可选值：
-1: 使用默认阈值，normal node模式下为 134217728 (128M), dragonfly node模式下为536870912(512M)
其他值：使用整数值，建议使用2的幂
默认值：-1
2.1.9 MCCL_THRESHOLD_TO_USE_CACHEABLE_BUFFER_P2P
描述：simple p2p模式下使用rwk buffer的阈值，大于此值时使用rwk buffer
可选值：
-1: 使用默认阈值 134217728 （128M）
其他值：使用整数值，建议使用2的幂
默认值：-1
2.1.10 MCCL_PCIE_BUFFER_MODE
描述：设置mccl中pcie buffer的工作模式，用于选择卡间通信是否使用PCIE链路进行通信。
可选值：
-1  自动选择，由服务器的GPU拓扑决定
0    首选mtlk
1    选择mtlk和pcie
2    只选择pcie
默认值：1
2.1.11 MCCL_TUNING_MODEL
描述：根据全局topo的种类设置了不同的算法选择适配模式，不同值会使用不同的算法固定延迟、带宽系数以及对应不同算法不同数据大小的带宽微调。
可选值：
5 单节点时推荐设置为5
6 多节点时推荐设置为6
默认值：5
2.1.12 MCCL_PROTO
描述：MCCL_PROTO变量定义MCCL将使用哪种协议。不建议用户设置此变量，除非在怀疑MCCL中存在错误的情况下禁用特定协议。特别是，在不支持LL128的平台上启用LL128可能会导致数据损坏。
可选值：
以逗号分隔的协议列表（不区分大小写），包括：LL、LL128、Simple。要指定要排除（而不是包含）的协议，请以^开头列表。
默认值：在支持LL128、LL、Simple的平台上，默认值为LL、LL128、Simple。
2.1.13 MCCL_ALGO
描述：MCCL_ALGO变量定义MCCL将使用哪些算法。
可选值：
以逗号分隔的算法列表（不区分大小写），包括：树、环、Collnet（最多2.13）、CollnetDirect（2.14+）和CollnetChain（2.14+）。
默认值：Tree, Ring, CollnetDirect (Not Support), CollnetChain (Not Support)
2.1.14 MCCL_DMABUF_ENABLE
描述：使用 Linux dma-buf 子系统启用 GPU Direct RDMA 缓冲区注册。Linux dma-buf 子系统允许支持 GPU Direct RDMA 的 NIC 直接读取和写入 CUDA 缓冲区，而无需 CPU 参与。
可选值：
0  禁用
1  使能
默认值：
       1 启用，但如果 Linux 内核或 CUDA/NIC 驱动程序不支持该功能，则会自动禁用该功能。
2.1.15 MCCL_EXT_CCL_ENABLE
描述：使能混训功能
可选值：
0  禁用
1  使能
默认值：
       0 禁用
2.1.16 MCCL_HC_PLUGIN
描述：指定异构环境使用的特定版本的插件动态库，通过配置该变量，可以将Metax GPU与指定其它厂商的GPU进行异构通信。
可选值：
插件动态库路径
默认值：
       /opt/maca/libmxccl.so
2.1.17 MCCL_RINGS
描述：
用户自定义环路，只在固定序号的GPU上进行ring运算。
可选值：
字符串格式： “0 1|1 0|0 1 2 3|3 2 1 0|N0 0 2 3 1|N2 7 6 5 4 3 2 1 0 N1"
其中网卡可选择指定字符前缀N表示
PCIE p2p 可以指定字符前缀P表示
默认值：无
2.1.18 MCCL_SWBX_USE_NET
描述：只针对3d mesh中 4 pcie + 4 roce拓扑，配置多机coll通信ring算法是否同时使用roce网卡和pcie
可选值：
0  多机通信只使用switch box pcie链路通信
1  默认值，多机通信同时使用switch box pcie链路和roce 网络通信;
默认值：1
2.1.19 MCCL_REMOTE_P2P_USE_NET
描述：只针对3d mesh中 4 pcie + 4 roce拓扑，配置多机通信send/recv是否同时使用roce网卡和pcie
可选值：
0  多机通信只使用switch box pcie链路通信
1  默认值，多机通信同时使用switch box pcie链路和roce 网络通信;
默认值：1
2.2.19 MCCL_GRAPH_MIXING_SUPPORT
描述：支持同时提交graph和非graph任务，开启后graph和非graph任务之间强制同步串行执行。
可选值：
0  默认值，关闭。在某些(VLLM开启graph异步提交跨机通信任务)场景下可能发生hang.
1  开启强流同步，不会hang, 开启graph时小size时延会增加。
默认值：0
2.2 性能相关
2.2.1 MCCL_ENABLE_FC
描述： 是否使能FC算法
可选值：
0: 关闭
1: 使能
默认值：1
2.2.2 MCCL_ENABLE_FC8_OAM
描述： 在8卡OAM拓扑下使能FC算法
可选值：
0: 关闭
1: 使能
默认值：1
2.2.3 MCCL_FC_BYTE_LIMIT
描述：使用FC算法的数据量上限。
可选值：无符号长整形数值
默认值： 4294967296
2.2.4 MCCL_FC_MAX_BLOCKS
描述：限制FC算法使用的block数量
可选值：
正整数值，其中0表示由算法自动选择。
默认值：32
2.2.5 MCCL_FC_DISABLE_REMOTE_READ
描述：关闭FC远读算法
可选值：
1:  关闭
0：打开
默认值：0
2.2.6 MCCL_FC_BYTE_LIMIT_DRAGONFLY
描述：限制Dragonfly拓扑下使用FC分层算法的数据量上限。
可选值：无符号长整型数值
默认值：2097152
2.2.7 MCCL_FC_MTLK_BLOCKS
描述：限制FC分层算法的metaxlink部分block数量
可选值：无符号长整型数值
默认值：-1：由算法根据拓扑自动选择
2.2.8 MCCL_LIMIT_RING_LL_THREADTHRESHOLDS
描述： 在Ring算法LL协议场景下是否限制
可选值：
0 关闭
1 使能
默认值：1 
2.2.9 MCCL_CROSS_NIC
描述：MCCL_CROSS_NIC变量控制MCCL是否允许ring /trees使用不同的网卡，导致节点间通信在不同节点上使用不同的网卡。
        为了在使用多个网卡时最大限度地提高节点间的通信性能，MCCL在节点间通信时尽量使用相同的网卡，允许每个节点上的每个网卡连接到不同的网络交换机(网络轨道)的网络设计，避免任何流量干扰的风险。因此, MCCL_CROSS_NIC 设置取决于网络拓扑，特别是取决于网络结构是否经过轨道优化。
这对只有一个网卡的系统没有影响。
可选值：
0: 始终在同一个环/树中使用相同的 NIC（网络接口卡），以避免跨越网络轨道。这适用于每个 NIC 都连接到独立交换机（轨道），且轨道间连接较慢的网络。请注意，如果通信器中每个节点上的 GPU 并不完全相同，MCCL 可能仍需要跨 NIC 进行通信。
1: 允许在同一个环/树中使用不同的 NIC。这适用于所有节点的 NIC 都连接到同一个交换机的网络，因此尝试仅使用相同的 NIC 并不能避免流量冲突。
2: 尽量在同一个环/树中使用相同的 NIC，但在能够获得更好性能的情况下，也允许使用不同的 NIC。
默认值: 2
2.2.10 MCCL_MIN_NCHANNELS
描述： MCCL_MIN_NCHANNELS 变量限制MCCL使用的最小channel数量。增加channel数量会增加MCCL使用的 block 数量， 这会提升性能但会使用更多的GPU计算资源。
        在一些MCCL经常只创建一个channel的平台使用聚合集合通信时，增加channel数量通常会带来性能提升。
        旧的变量MCCL_MIN_NRINGS仍然可以作为别名使用。 如果设置了MCCL_MIN_NCHANNELS，将覆盖MCCL_MIN_NRINGS。
可选值：
整数值。当设置channel数为-2时，最终结果会配置成默认值。否则，当设置的channel数小于0时，会配置成0；当channel数量大于MAXCHANNELS（同构拓扑MAXCHANNELS=64，异构MAXCHANNELS=32）时，会配置成MAXCHANNELS；
默认值：2
2.2.11 MCCL_MAX_NCHANNELS
描述：MCCL_MAX_NCHANNELS 限定了MCCL可以使用的channel数量。 减少channel数量会减少通信库使用的block数量，相应的会影响GPU的计算资源。
        旧的MCCL_MAX_NRINGS仍然可以作为别名使用。如果设置了MCCL_MAX_NCHANNELS，将覆盖MCCL_MAX_NRINGS
可选值：大于等于1的整数值。当设置channel数为-2时，最终结果会配置成默认值。否则，当设置的channel数小于1时，会配置成1；当channel数量大于MAXCHANNELS（同构拓扑下MAXCHANNELS=64，异构MAXCHANNELS=32）时，会配置成MAXCHANNELS；当 MCCL_MIN_NCHANNELS设置的值比MCCL_MAX_NCHANNELS设置的大，最终结果会取两者最大值。
默认值：32
2.2.12 MCCL_RING_TP8_MODE
描述：用户使用MCCL_RING_TP8_MODE 设定当前为Dragonfly TP8 拓扑模式，并指定预设的通信环路
可选值：
0: 不适用预设通信环路
1:  使用 8 opt 环路
2:  使用 8opt 环路 和 3 pcie 环路
3:  使用 16 opt 和 6 rc 和 8 roce 环路
4:  使用 16 opt环路 和 6 rc 环路
默认值：0
2.2.13 MCCL_NET_DISABLE_INTRA
描述：
Intra-node通信时，当使用网卡通信速度高于P2P或SHM时，允许优先使用网卡。
可选值：
0:  允许优先使用网卡
1:  不允许优先使用网卡
默认值： 1
2.2.14 MCCL_PXN_DISABLE
描述：禁止节点内通信使用PXN，即通过MetaxLink、中间GPU和非local网卡进行通信。
可选值：
0： 非禁止
1： 禁止
默认值：0
2.2.15 MCCL_MIN_P2P_NCHANNELS
描述：MCCL可用在P2P通信的最小channel数量。
可选值：整数值
默认值：1
2.2.16 MCCL_MAX_P2P_NCHANNELS
描述：MCCL可用在P2P通信的最大channel数量。
可选值：整数值
默认值：32
2.2.17 MCCL_P2P_NCHANNELS
描述：该变量设置了MCCL在P2P通信时使用的channel数量
可选值：整数值
默认值：12
2.2.18  MCCL_TUNING_FILE
描述：用户指定调优配置文件路径。
可选值：可访问的用户自定义文件路径
默认值：/opt/maca/etc/tuning.cfg
2.2.19 MCCL_TOPO_FILE
描述：在检测拓扑之前要加载的XML文件的路径。默认情况下，MCCL将加载/var/run/metax/topo.xml(如果存在)。
可选值：
描述部分或全部拓扑的可访问文件的路径
默认值：/var/run/metax/topo.xml
2.2.20 MCCL_TOPO_DUMP_FILE
描述：检测后要将XML格式拓扑存储的文件路径
可选值：
要创建或者覆盖的文件路径
默认值：同MCCL_TOPO_FILE
2.2.21 MCCL_P2P_DISABLE
描述：MCCL_P2P_DISABLE变量禁用基于PCIE或Metaxlink的GPUDirect技术的点对点(P2P)传输
可选值：
1： 禁用
0： 不禁用
默认值：0 
2.2.22 MCCL_P2P_LEVEL
描述：MCCL_P2P_LEVEL变量允许用户精细地控制何时在gpu之间使用点对点(P2P)传输。该级别定义了MCCL将使用P2P传输的gpu之间的最大距离。应该使用表示路径类型的短字符串来指定使用P2P传输的地形截止点。如果没有指定，MCCL将尝试根据运行的体系结构和环境选择最佳值。
可选值：
字符串类型值：
 LOC:永远不要使用P2P(总是禁用)
MetaxLink:  gpu通过MetaxLink连接时使用P2P
PIX: gpu位于同一PCI交换机时，使用P2P。
PXB:当gpu通过PCI交换机(可能有多跳)连接时，使用P2P。
PHB: gpu位于同一个NUMA节点时使用P2P。流量将通过CPU。
SYS:在NUMA节点之间使用P2P，可能会跨越SMP互连(例如QPI/UPI)。
整数类型值（Legacy）
还可以选择将MCCL_P2P_LEVEL声明为与路径类型对应的整数。对于那些在允许字符串之前使用数值的人来说，保留这些数值是为了向后兼容。
不鼓励使用整数值，因为这会破坏路径类型的变化——文字值会随着时间的推移而变化。为了避免调试配置时遇到的麻烦，请使用字符串标识符。
LOC: 0
PIX:1
PXB: 2
PHB:3
SYS:4
大于4的值将被解释为SYS。MetaxLink不支持使用旧的整数值。
默认值：无
2.2.23 MCCL_DF16_RINGS
描述：Dragonfly 16卡拓扑使用的基础环路路径。
可选值：通过GPU的divice id构建的环路路径
默认值：
0 4 7 3 6 2 1 5 15 11 8 12 9 13 14 10|3 7 4 0 5 1 2 6 12 8 11 15 10 14 13 9|4 3 0 7 2 5 6 1 11 12 15 8 13 10 9 14|7 0 3 4 1 6 5 2 8 15 12 11 14 9 10 13|10 14 13 9 8 11 15 5 1 2 6 3 7 4 0|9 13 14 10 15 11 8 12 6 2 1 5 0 7 3|14 9 10 13 8 15 12 11 1 6 5 2 7 0 3 4|13 10 9 14 11 12 15 8 2 5 6 1 4 3 0 7
2.2.24 MCCL_IGNORE_CPU_AFFINITY
描述： MCCL_IGNORE_CPU_AFFINITY 变量可以用于让 MCCL 忽略作业提供的 CPU 亲和性，而仅使用 GPU 亲和性。
可选值：
0： 不忽略CPU亲和性。
1： 忽略作业提供的 CPU 亲和性。
默认值：0
2.2.25 MCCL_RUNTIME_CONNECT
描述： MCCL_RUNTIME_CONNECT可控制是否分配所有算法对应的Buffer空间。从性能角度看，数据传输过程中不使用的算法可以不分配Buffer空间，以减少HBM空间占用。
可选值：
0： 分配所有算法Buffer空间。
1： 只分配所使用算法的Buffer空间。
默认值：1
2.2.26 MCCL_HFC_EP4_KERNEL_LIMIT
描述： MCCL_HFC_EP4_KERNEL_LIMIT 可控制alltoall4卡算法在dragonfly switch拓扑下的算法选择，该值具体为4卡(每个机器一张卡)走HFC的kernel的限制值，小于等于该值时走ep4的kernel，大于该值时走send/recv算法。
可选值：
0-0x7fffffffffffffff。
默认值：524288
2.2.27 MCCL_HFC_EP8_KERNEL_LIMIT
描述： MCCL_HFC_EP8_KERNEL_LIMIT 可控制alltoall8卡算法在dragonfly switch拓扑下的算法选择，该值具体为8卡(每个机器一张卡)走HFC的kernel的限制值，小于等于该值时走ep8的kernel，大于该值时走send/recv算法。
可选值：
0-0x7fffffffffffffff。
默认值：524288
2.2.28 MCCL_ENABLE_FC_ALL_TO_ALL_MASK
描述： 控制不同拓扑的alltoall是否启用FC算法:
bit 0: A2A FC4
bit 1: A2A FC8
bit 2: A2A HFC8
bit 3: A2A HFC16
bit 4: A2A HFC32
bit 5: A2A SWITCH4
bit 6: A2A SWITCH8
bit  : others server 
可选值：
默认值：0b01111111
2.2.29 MCCL_HFC_EP8_KERNEL_LIMIT
描述： MCCL_HFC_EP8_KERNEL_LIMIT 可控制alltoall8卡算法在dragonfly switch拓扑下的算法选择，该值具体为8卡(每个机器一张卡)走HFC的kernel的限制值，小于等于该值时走ep8的kernel，大于该值时走send/recv算法。
可选值：
0-0x7fffffffffffffff。
默认值：524288

2.2.30 MCCL_FC_READ_START_SYNC
描述： MCCL_FC_READ_START_SYNC 控制FC算法远读时，是否在kernel开始时加一次数据同步，理由是使用远读实现的程序去读取其他rank的数据时，可能其他rank的数据还不在hbm中，加了同步可以保证相互的rank同时到达kenrel的开始，而在kernel启动时UMD会保证数据进入到hbm中。但是如果开启该选项会导致一定程度的性能下降，如果可以保证通信的rank数据ready（在hbm中），则不需要开启该环境变量。
可选值：
0-关闭
1-开启
默认值：1

2.2.31 MCCL_MXB_DISABLE
描述： MCCL_FC_READ_START_SYNC 控制FC算法远读时，是否在kernel开始时加一次数据同步，理由是使用远读实现的程序去读取其他rank的数据时，可能其他rank的数据还不在hbm中，加了同步可以保证相互的rank同时到达kenrel的开始，而在kernel启动时UMD会保证数据进入到hbm中。但是如果开启该选项会导致一定程度的性能下降，如果可以保证通信的rank数据ready（在hbm中），则不需要开启该环境变量。
可选值：
0-关闭
1-开启
默认值：0

2.2.32 MCCL_FC_DISABLE_DIRECT_WRITE
描述： 针对全连接2卡/4卡/8卡的AllReduce、AllGather、AllToAll原语的远写FC kernel做了优化，去除中间buffer减少数据搬运次数（零拷贝），性能可以提升5%~20%。
可选值：
0-开启优化
1-禁用优化
默认值：1
2.3 网络相关
2.3.1 MCCL_SHM_DISABLE
描述：MCCL_SHM_DISABLE设置为1后将禁用共享内存（SHM）传输，MCCL 将使用网络（即 InfiniBand 或 IP 套接字）在 CPU 套接字之间进行通信。
可选值：
0:  使能共享内存（SHM）传输。
1:  关闭共享内存（SHM）传输。
默认值：0
2.3.2 MCCL_IB_GID_INDEX
描述：RoCE模式中的Global ID索引。用于标识通信使用IPv4或IPv6，RoCE v1或RoCE v2协议。
可选值：
-1，0，正整数。
默认值：-1
2.3.3 MCCL_IB_DISABLE
描述：MCCL_IB_DISABLE 变量可防止 MCCL 使用 IB/RoCE 传输。相反，MCCL 将恢复使用 IP 套接字。
可选值：
0:  使能IB/RoCE 传输。
1:  使能IP套接字传输。
默认值：0
2.3.4 MCCL_SOCKET_FAMILY
描述：允许用户强制 MCCL 只使用 IPv4 或 IPv6 接口。
可选值：
设为 AF_INET 则强制使用 IPv4，设为 AF_INET6 则强制使用 IPv6。
默认值：无
2.3.5 MCCL_SOCKET_IFNAME
描述：指定使用哪些 IP 接口进行通信。
未指定IP接口时，MCCL默认选择"ib"前缀的网络接口；
当找不到"ib"前缀接口时，选择其他接口，但不包含"docker,lo,virbr"前缀的网络接口，如"bond0"；
接口查找失败后，依次选择"docker,lo,virbr"前缀的网络接口；
如果某个网络接口网络存在问题，会导致建链失败；若用户预先了解某个接口可用，建议设置该环境变量。

是否添加环境变量MCCL_SOCKET_IFNAME和网卡配置强相关，默认场景，MCCL会按上述规则自动搜索对应网口，如只有一个socket网口，可不手动设置，如有多个，且命名等配置不统一，需指定；或者为防止出现不可预知的混乱问题，可以直接指定。
可选值：
定义为前缀列表，用于筛选 MCCL 将使用的接口。可以提供多个前缀，以 , 符号分隔。使用 ^ 符号，MCCL 将排除以该列表中任何前缀开头的接口。要匹配（或不匹配）精确的接口名称，请在前缀字符串的开头使用 = 字符。
默认值：无
2.3.6 MCCL_IB_HCA
描述：指定使用哪些 RDMA 接口进行通信。
可选值：
定义用于筛选 MCCL 将使用的 IB Verbs 接口。列表以逗号分隔；端口号可使用 : 符号指定。可选前缀 ^ 表示该列表是排除列表。第二个可选前缀 = 表示标记为精确名称，否则 MCCL 默认会将每个标记视为接口前缀。
默认值：无
2.3.7 MCCL_NET_GDR_LEVEL
描述： MCCL_NET_GDR_LEVEL 允许用户精细控制何时在 NIC 和 GPU 之间使用 GPU Direct RDMA。 该变量使用表示路径类型的字符串来指定 NIC 和 GPU 之间允许使用GPU Direct RDMA 的最大距离级别。如果未指定，MCCL 将尝试根据其运行的体系结构和环境以最佳方式选择一个值。
可选值：
LOC:             从不使用 GPU Direct RDMA（始终禁用)，C600/N300表示只使用本地Metax_eth来使用GPU Direct RDMA。
MetaxLink:  GPU通过MetaxLink连接NIC时使用GPU Direct RDMA.
PIX:              当 GPU 和 NIC 位于同一 PCI 交换机上时，使用 GPU Direct RDMA。
PXB:             当 GPU 和 NIC 通过 PCI 交换机（可能是多跳）连接时，使用 GPU Direct RDMA。
PHB:             当 GPU 和 NIC 位于同一 NUMA 节点上时，使用 GPU Direct RDMA。流量将通过 CPU。
SYS:              即使在 NUMA 节点之间的 SMP 互连中也可以使用 GPU Direct RDMA（始终启用）。
整数类型值（Legacy）
还可以选择将 MCCL_NET_GDR_LEVEL 声明为对应于路径类型的整数。保留这些数值是为了追溯兼容性，适用于在允许字符串之前使用数值的用户。
由于路径类型后续可能更改，数值与类型字符串标识符的映射关系可能会相应变化， 不建议使用整数值。为避免调试配置时遇到麻烦，请使用字符串标识符。
LOC: 0
PIX: 1
PXB: 2
PHB: 3
SYS: 4
大于4的值将被解释为SYS。
默认值：无
2.3.8 MCCL_IB_QPS_PER_CONNECTION
描述： MCCL_IB_QPS_PER_CONNECTION设置每个通信连接使用的IB qp数量。
可选值：正整数
默认值：1

2.4 调试相关
2.4.1 MCCL_DEBUG
描述：控制MCCL日志打印级别，日志级别高的等级包含低等级日志信息。
可选值：
NONE：日志级别为0，不打印任何日志
VERSION：日志级别为1，打印MCCL库版本号信息
WARN：日志级别为2，打印MCCL错误信息
INFO：日志级别为3，打印调试信息
ABORT：日志级别为4，打印错误终止信息
TRACE：日志级别为5，打印函数的调用日志信息
默认值：-1 ，不打印任何日志信息
2.4.2 MCCL_DEBUG_SUBSYS
描述：用于过滤日志输出的模块，通过逗号分割，可以输出多个模块的日志内容。
主要包括：INIT,COLL,P2P,SHM,NET,GRAPH,TUNING,ENV,ALLOC,CALL,DATA
可选值：
    INIT：初始化模块
    COLL: 集合操作模块
    P2P：Peer To Peer传输模块
    SHM: 共享内存传输模块
 DATA：传输数据信息打印
    NET: 网络传输模块
    GRAPH：拓扑检测和拓扑图搜索
    TUNING：（TREE/RING/COLL）算法和（Simple/LL/LL128）协议调优
    ENV: 环境变量
 ALLOC: 内存申请
 CALL: 函数调用相关信息
    ALL: 所有模块
默认值：0，不打印任何日志信息 
2.4.3 MCCL_DEBUG_FILE
描述：指定调试日志的生成的日志文件，格式：filename.%h.%p, %h – 主机名，%p – 进程号。不支持~字符，需要使用相对路径或绝对路径
可选值：用户自定义输入
默认值：为空，生成的日志文件路径: $HOME/mxlog/mccl.pid.timestamp.log

2.5 UMD相关
2.5.1 FORCE_ACTIVE_WAIT
描述：指定UMD中Host侧等待事件或流之间同步的CPU行为，2025/7发布的MACA 3.0.0中已更名为MACA_EXT_CPU_THREAD_POLICY。
可选值：
0 默认标准模式，阻塞等待计算任务完成
1  该进程抢占CPU进行等待相对温和
2  该进程抢占CPU进行等待比较激进
3 该进程抢占CPU进行等待最激进
-1 该进程等待时尽量让出CPU，可以有效降低在使用大量流的场景下的CPU负载
默认值：0
2.5.2 MACA_VISIBLE_DEVICES
描述：服务器中有多个GPU，可以选择特定的GPU对应用程序可见性及运行顺序。可以指定GPU UUID ， GPU设备节点ID 或者 GPU的socket id（socket id当前仅限dragonfly服务器），例如：
1）指定GPU UUID：
export MACA_VISIBLE_DEVICES=GPU-ad23670d-a40e-6b86-6fc3-c44a2cc92c7e
2）指定 GPU设备节点ID：
export MACA_VISIBLE_DEVICES=0,2
3）指定GPU的socket id，前缀为S或s：
       export MACA_VISIBLE_DEVICES=S0,S2,S5 或者 export MACA_VISIBLE_DEVICES=s0,s2,s5
可选值：
UUID/节点ID/socket id，  
通过mx-smi -L命令可以获取所有GPU的UUID；
通过mx-smi命令获取GPU节点ID；
通过命令 grep -rn mgpu_id /sys/class/mxcd/mxcd/layout/nodes ，可查看GPU socket id
默认值：空
2.5.3 MACA_DEVICE_ORDER
描述：服务器中有多个GPU，在程序调用过程中可以按照期望的规则生成GPUindex，C500支持的多卡排序规则
可选值：
FASTEST_FIRST 根据设备计算能力从快到慢排序，
PCI_BUS_ID 根据PCI总线ID升序排列设备。
默认值：FASTEST_FIRST
2.5.4 MXLOG_LEVEL
描述：设置maca umd的输出日志等级
可选值：
verbose：日志级别为0，打印verbose日志
debug：日志级别为1，打印debug日志
info：日志级别为2，打印info日志
warn：日志级别为3，打印warning日志
err：日志级别为4，打印error日志
critial：日志级别为5，打印critial日志
off：日志级别为6，关闭日志打印
默认值：release版本是err，dubug版本是debug。
2.5.5 MACA_LAUNCH_MODE
描述：设置下发GPU任务时的刷缓存行为，目前在验证阶段
可选值： 
0：每个GPU任务完成后都会刷一次L1和L2缓存
1：每个GPU任务完成后只刷L1缓存，不刷VL1S
2：每个GPU任务完成后只刷SL1缓存，不刷VL1和L2
默认值：0，后续大规模测试通过后会默认配置为1
2.5.6 MACA_DIRECT_DISPATCH
描述：配置stream下发任务时驱动侧的行为
可选值： 
0：每个Stream会额外创建一个线程管理该Stream上的任务并提交到硬件执行
1：Stream上的任务由application线程直接管理并提交到硬件去执行，多Stream场景下CPU负载较低
默认值：默认值为0，后续经大规模验证后会将默认值配置为1

2.5.7 MACA_PRIORITY_QUEUE_POLICY
描述：为三个优先级的16个队列设置分配策略
可选值：0xHNL
H/N/L 分别为 高优先级，普通优先级和低优先级queue的数量。
低优先级queue的数量必须大于0。
若希望High优先级使用12个queue，Normal优先级和Low优先级各使用2个queue，则环境变量可配置为：
       export MACA_PRIORITY_QUEUE_POLICY=0xc22
默认值：0x844

2.6 工具相关
主要针对mccl test和transferbench等工具的环境变量。
2.6.1 MX_TRACER_ENABLED_MCPTI
描述：mccl test中用于控制是否进行mccl kernel时长度量。
可选值：
ON：进行mccl kernel时长度量。
OFF：不进行mccl kernel时长度量。
默认值：OFF
2.6.2 NCCL_TESTS_SPLIT_MASK
描述：mccl test perf 测试中，在MPI多进程场景，实现分组并行执行集合通信操作，以模拟大模型的通信行为。
假设每个进程编号为rank（假设共4个进程，编号一般为0~3），组号为color，配置NCCL_TESTS_SPLIT_MASK=mask，则：color =rank ＆ mask，相同color的进程会被分为一个子进程组，组内独立执行集合通信操作，组间行为并行。
 如：运行8卡all_reduce_perf，配置NCCL_TESTS_SPLIT_MASK=3，根据公式，则卡0和卡4 color（0）相同，卡1和卡5 color（1）相同，...... 以此类推，最终共有4个子进程组，卡0和卡4，卡1和卡5，卡2和卡6，卡3和卡7分别做组间2卡all_reduce_perf，四组all_reduce_perf并行执行。
可选值：
16进制数，如0x7
默认值：0
2.6.3 MCCL_OPTIMIZATION_A2A
描述：mccl test中用于控制是否开启all to all优化，只适用于单机全互联和多机Dragonfly拓扑，该优化通过调用mcclAllToAll实现。
可选值：
0：不开启优化。
1：开启优化。
默认值：1
2.6.4 P2P_MODE
描述：TransferBench中用于控制P2P是单向或者双向测试。
可选值：
0：只进行单向P2P测试。
1：分别进行单向和双向测试。
默认值：0


三、技术支持
技术支持详询沐曦通信库团队，更多的环境变量说明请参考《MCCL环境变量指南全集》。

四、附录
特殊机型环境变量配置说明：
1、阡视服务器：8卡性能最优服务器，需要置MACA_VISIBLE_DEVICES=0,1,8,9,2,3,10,11,4,5,12,13,6,7,14,15
2、、C588机型：由于其特殊的拓扑互联及已知的硬件限制问题，不同的通信切分模式需要设置不同的设备顺序；
     （1）优先使用MACA_VISIBLE_DEVICES=0,1,2,3,6,5,4,7,10,9,8,11,14,15,12,13     
     （2）切分方式包含DP4或PP4的，使用MACA_VISIBLE_DEVICES=0,1,2,3,6,5,4,7,10,11,8,9,14,13,12,15
     另外有其他几种场景可以在灵活设置下正常运行，但仍然建议配置为上述（1）中所设置的内容：
     （3）TP16：可以不设置MACA_VISIBLE_DEVICES，使用默认顺序，或者设置为任意顺序；
     （4）TP2DP8：可以不设置MACA_VISIBLE_DEVICES，使用默认顺序。
  注：C588海光cpu型号的服务器默认设备序和上述intel CPU型服务器有差异，海光cpu服务器需要对上述设置部分顺序交换：2<-->6, 3<-->7, 12<-->14, 13<-->15。
3、C600 OAM机型：模型通信要达到性能最优，
      需使用MACA_VISIBLE_DEVICES=0,4,8,12,6,2,10,14,1,5,9,13,7,3,11,15




