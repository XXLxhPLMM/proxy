import path from "path";
import CopyPlugin from "copy-webpack-plugin";
export default {
  entry: "./src/app.ts", // 你的入口文件
  target: "node", // 指定目标环境为 Node.js
  mode: "production", // 生产模式
  module: {
    rules: [
      {
        test: /\.ts$/, // 匹配 TypeScript 文件
        use: "ts-loader",
        exclude: /node_modules/,
      },
    ],
  },
  stats: {
    errorDetails: false, // 显示详细错误信息
  },
  resolve: {
    extensions: [".ts", ".js"], // 解析扩展名
  },
  experiments: {
    outputModule: true, // 启用输出为 ES 模块
  },
  output: {
    filename: "app.js", // 输出文件名
    module: true, // 启用 ES 模块

    // format:"module", // 输出格式为 ES 模块
    path: path.resolve(process.cwd(), "dist"), // 输出目录
    clean: true, // 在每次构建之前清除文件
  },
  plugins: [
    new CopyPlugin({
      patterns: [
        {
          from: "package.json",
          to: "./package.json",
        },
        {
          from: "README.md",
          to: "README.md",
          toType: "file",
        },
        {
          from: ".gitignore",
          to: ".gitignore",
          toType: "file",
        },
        { from: ".env", to: ".env", toType: "file" },
      ],
    }),
  ],
};
