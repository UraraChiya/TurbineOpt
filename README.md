# TurbineOpt · 涡轮线圈布局优化器

NuclearCraft: Overhauled 涡轮机（Turbine）端面**线圈 / 电磁铁布局**自动优化工具。
输入线圈平面边长 N 与轴承边长 B，工具会自动搜索使端面**导电率（Dynamo Efficiency）最大**的布局，
并可导出为建筑小帮手模板或原版结构方块 `.nbt`。

实现参考了本目录下的 [`FissionOpt/`](FissionOpt)（同样是纯前端工具）。本工具为**纯静态前端**，
不需要编译或服务端，直接双击 `index.html` 即可使用。

## 使用方法

1. 用浏览器打开 `index.html`。
2. 设置「线圈平面边长 N」「轴承边长 B」。要求：
   - `N`、`B` 同奇偶；
   - `B ≤ N − 2`。
3. 选择可用线圈（不需要的取消勾选，或填写「上限」限制数量）。将光标悬停在预览中的线圈格或
   列表中的线圈行上，会显示该线圈的**放置条件**（即它需要相邻满足的规则）。
4. 点击「开始优化」。优化会**持续运行**并实时刷新当前最优布局、导电率与导出内容；可随时「暂停 / 继续」
   或「停止」。导出区域文本框与「复制到剪贴板」在运行过程中即为最新结果，无需先停止。
5. 在「参数」区域用「剩余墙体填充」选择用**涡轮机外壳**或**涡轮机玻璃**填充空余墙格；在「导出」
   区域选择需要的格式。

每个端面默认预留 2 个空格用于控制器与流体输入输出口，这些格子的**具体位置由优化器决定**
（默认不指定）。点击右侧网格中的任意非轴承格子可以**手动钉住**该预留格，再次点击取消。
预留格保持为空，导出为空气。

所有参数（N / B、每面预留格数、剩余墙体填充、每个线圈的启用与上限、导出原点、手动钉住的预留格）
都会自动保存到浏览器 **localStorage**（键 `turbineopt.settings.v1`），刷新或重新打开页面后自动恢复；
清除浏览器站点数据即可重置。

## 部署到 GitHub Pages

仓库自带 [`.github/workflows/pages.yml`](.github/workflows/pages.yml)：推送到 `master` 分支会自动发布，
也可在仓库 **Actions → Deploy to GitHub Pages → Run workflow** 手动触发。工作流只收集运行时需要的静态文件
（`index.html`、`css/`、`js/`、`assets/`），不会上传 `resources/`、`scripts/`、`tools/`、jar 等构建素材，
因此发布产物很小。

首次启用需在仓库 **Settings → Pages → Source** 选择 **GitHub Actions**（工作流里的 `configure-pages`
也会尝试自动开启）。发布地址形如 `https://<用户名>.github.io/<仓库名>/`。

## 导电率模型

与游戏内 `nc.multiblock.turbine.TurbineLogic` 完全一致：

- 每个端面：
  - `M` = 该端面上**有效**线圈数量（连接器不计）；
  - `S` = 这些线圈的导电率之和；
  - 端面导电率 `= S / max(B², M)`。
- 整机导电率 = 两个端面的平均值。两端面使用相同布局时，整机值等于单面值。
- `bearingCount = 2·B²`，因此分母中的 `bearingCount/2 = B²`。

> 分母用的是 `max`，所以**轴承数量是一条「下限」，并不要求线圈数大于轴承数**。更准确的实用规则是：
> - 当 `M < B²` 时，分母恒为 `B²`，该面导电率 = `S / B²`。若该面使用同种线圈，等效于按 `M / B²`
>   的比例缩水——这正是 mcmod 百科所述的规则（每面 4 个轴承、只放 3 个线圈 → 产出变成 `3/4`）。
> - 当 `M ≥ B²` 时，分母变为 `M`，缩水消失，导电率 = 这些线圈传导率的平均值 `S / M`。此时再增加
>   线圈，只有其传导率高于当前平均 `S/M` 才会提升，否则会稀释平均值。
> - 因此经验法则是：**每个轴承所在面至少放满 `B²` 个有效线圈**；`M < B²` 时每少一个都会按比例
>   拉低该面产出。`M = 0` 时该面导电率为 0。结果面板会在 `M < B²` 时给出提醒。

「有效」线圈的定义与 `refreshDynamos` 的最小不动点一致：从紧邻轴承的根线圈（规则含 `bearing`）
出发，规则被已满足的线圈 / 轴承满足，且可从根可达。所有已知规则都是 `at least`，
因此「规则满足」等价于「存在至少一个满足条件的相邻部件」。邻接为标准六向，但在端面内
实际只有同平面的 4 个邻格是线圈。

## 算法

目标是最大化端面导电率 `S / max(B², M)`。最优布局通常是**围绕轴承的一小块高导电率线圈群**，
而不是把整个平面填满（填满会拉低平均值）。

1. **势能贪心生长**：为每种线圈计算「前向势能」（沿依赖图能达到的最高导电率），每一步放置当前
   可行且势能最高的部件，从而优先搭建通往高阶线圈（最高 2400）的依赖链。记录这条生长轨迹上
   导电率最高的中间布局作为初始解。
2. **大邻域搜索（LNS / ruin-and-recreate）**：反复在当前解上**随机删除**一部分线圈，再用势能
   贪心重新生长；生长中带少量随机抖动以产生多样化的重建。采用「record-to-record」准则，允许
   接受略微变差的解以跳出局部最优（容差随轴承大小增大），同时单独保存全局最优并持续更新。
3. **剪枝**：移除所有不在有效网络中的部件（最小不动点与无效部件无关，因此剪枝安全）。

搜索在主线程分片运行，界面保持响应。默认**持续运行直到手动停止**，可随时暂停 / 继续；每一步的
中间结果都会实时刷新。

## 导出格式

| 格式 | 文件 | 用途 |
| --- | --- | --- |
| 建筑小帮手（Building Gadgets） | `.snbt` | 1.12.2 的模板以**剪贴板 NBT 文本**交互：点击「复制到剪贴板」，在游戏内模板管理器（Template Manager）点击 **Paste**。 |
| 原版结构方块 | `.nbt` | 放入 `<存档>/generated/minecraft/structure/`，用结构方块加载。 |

> 注意：Building Gadgets **1.12.2** 并不使用 `.json` 模板（那是 1.14+ 的格式），
> 而是把 `NBTTagCompound.toString()` 的 SNBT 文本放进剪贴板，由 `JsonToNBT` 解析。
> 因此这里导出的是与之完全兼容的 SNBT（可直接粘贴导入）。导出坐标原点仅影响建筑小帮手的
> `startPos`；结构方块 `.nbt` 始终使用局部坐标。

方块对应关系：

- 外壳：`nuclearcraft:turbine_casing[frame=false]`
- 玻璃：`nuclearcraft:turbine_glass`
- 轴承：`nuclearcraft:turbine_rotor_bearing`
- 连接器：`nuclearcraft:turbine_coil_connector`
- 原版 6 种线圈：`nuclearcraft:turbine_dynamo_coil`（metadata 0..5，属性 `type=magnesium…silver`）
- 附加线圈：`nuclearcraft:turbine_dynamo_coil_<id>`

## 数据来源

- 原版 6 种线圈的导电率与规则：NuclearCraft 默认配置。
- 附加线圈：由 [`tools/parse_coils.py`](tools/parse_coils.py) 解析
  [`scripts/NTP/`](scripts/NTP) 下的 CraftTweaker 脚本生成 [`js/coils.js`](js/coils.js)，
  并从 [`resources/lang/`](resources/lang) 读取中英文名称。修改脚本后重新运行：

  ```bash
  uv run tools/parse_coils.py
  ```

## 材质与图标

界面中的线圈图标与预览网格直接使用游戏内的**真实材质**：

- 附加线圈材质来自 [`resources/textures/blocks/`](resources/textures/blocks) 的 `coil_<id>.png`；
- 原版 6 种线圈材质取自 mod jar 的 `turbine/dynamo_coil/`；
- 各线圈对应的具体材质文件名由 [`resources/blockstates/`](resources/blockstates) 中的方块状态决定；
- 连接器、外壳、玻璃、轴承等部件材质同样取自 jar。

为了减少请求数，所有材质（116 种线圈 + 连接器 / 外壳 / 玻璃 / 轴承 / 预留）被合并为**一张图集**
`assets/coil-atlas.png`（16×16 格），并由 [`tools/build_atlas.py`](tools/build_atlas.py) 生成
坐标索引 [`js/atlas.js`](js/atlas.js)。修改或新增材质后重新运行：

```bash
uv run tools/build_atlas.py
```

图集按像素图渲染（`image-rendering: pixelated` / 关闭 `imageSmoothingEnabled`），不做平滑缩放。
所有图标与预览格**只显示材质本身，不叠加文字**；部件名称只在左侧列表与图例的文字部分、以及悬停提示中给出。

## 目录结构

```
index.html          界面
css/style.css       样式
js/coils.js         自动生成的线圈数据（请勿手改）
js/atlas.js         自动生成的材质图集索引（请勿手改）
js/rules.js         放置规则解析器
js/texture.js       材质图集查找 / 图标辅助
js/optimizer.js     势能贪心 + 大邻域搜索（LNS）优化器
js/nbt.js           最小 NBT 编码器（含 gzip）
js/export.js        SNBT / 结构 NBT 导出
js/main.js          界面逻辑
assets/coil-atlas.png  合并后的材质图集
tools/parse_coils.py   线圈数据生成脚本
tools/build_atlas.py   材质图集生成脚本
resources/          资源包（blockstates / textures / lang）
scripts/NTP/        NTP 附加线圈定义
.github/workflows/pages.yml   GitHub Pages 部署工作流
```

## 已知限制

- 模型只考虑**两个端面**的线圈环（这是线圈的主要放置位置，也是用户输入「线圈平面」的含义）。
  游戏代码中 `WALL` 部件理论上也可放在与转轴平行的侧壁上并经边角与端面相连；本工具不建模侧壁布局。
- 不导出完整涡轮机结构，只导出线圈平面（竖直单层）；两个端面假定使用相同布局。
- 导出 `.nbt` 需要浏览器支持 `CompressionStream`（新版 Chrome / Edge / Firefox / Safari）。
