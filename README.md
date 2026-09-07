# pi-extensions

这个仓库提供独立的 Pi Skill 管理器。插件源码位于 `capability-manager/`，不读取、不修改、也不依赖任何 MCP adapter。

## 安装

```bash
pi install git:github.com/Meursau1T/pi-extensions
```

私有仓库也可通过 SSH 安装。

```bash
pi install git:git@github.com:Meursau1T/pi-extensions.git
```

安装后重启 Pi，或执行 `/reload`。

## 使用

执行 `/caps` 打开 Skill Manager。Tab 或 Ctrl+G 切换全局与项目作用域，输入文字搜索，使用方向键移动，空格或 Enter 切换状态，Ctrl+S 保存，Esc 放弃。

项目状态支持继承、显式启用和显式禁用。状态通过 Pi 原生 `skills` 与 package filters 保存。插件不会移动或改写 `SKILL.md`。当前进程临时注入的 Skill 只读展示。

## MCP

MCP 不属于这个插件的职责。需要 MCP 时请单独安装和使用官方 `pi-mcp-adapter`。

```bash
pi install npm:pi-mcp-adapter
```

`pi-mcp-adapter` 2.32.1 及以上可通过 `/mcp` 面板或 `/mcp enable <server>`、`/mcp disable <server>` 独立控制 Server。

## 目录

`capability-manager/` 包含 Skill 管理界面、资源发现和全局／项目配置写入逻辑。
