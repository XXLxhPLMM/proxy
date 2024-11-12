import { loadConfig } from './config/load.js';
import { start } from './starter/index.js';
// 加载配置
loadConfig()
// 启动应用
start(process.env.PORT || 3000,null,()=>{
    console.log('Server started on port '+process.env.PORT || 3000)
})
