# tests/unit/core/request-scope/ — `RequestScope` 那一圈（分配面 + 组装面）的判据

本目录只答一件事：**逐请求数据绝不能存在共享实例上**，而这条铁律在源码上**哪几处不许漂**。
`RequestScope` 是 core 唯一的逐请求作用域载体；它被造出来的地方在 `src/core/server/admission.ts`
（唯一调用点），被消费的地方是四个入站通道的 `scope: RequestScope` 形参。

## 相关路径

- `src/core/forward/base.ts` — `ForwarderBase`：四个子类共用的那条「绝不存实例字段」铁律。
- `src/core/forward/channel/` — 四个入站通道（`http` / `tunnel` / `upgrade` / `socks`），构造签名
  逐字三件套，逐请求数据经 `scope: RequestScope` 进来（**type-only 引用**）。
- `src/core/server/{http.ts,socks-base.ts}` — 两条入站路径（都只调准入层的 `scopeFor`）与
  `SocksProxyBase` 的转发器字段初始化器。
- `src/core/server/admission.ts` — `createRequestScope` 在 `src/**` 里**唯一**的那个调用点。
- `../server/AGENTS.md` — 派发表那侧（入口方法名与派发按表走）。
- `../dead-optionality.test.ts` — 同一族护栏的另一半（可选形参那一侧）。