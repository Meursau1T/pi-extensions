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

`skills/` 下同一个第一层目录中的 Skill 会显示为一个文件夹。文件夹开关会递归控制其中现有及以后新增的 Skill，`[~]` 表示目录内状态不一致。切换整个文件夹会清除旧的子项覆盖，随后仍可单独切换某个 Skill 作为例外。软链接按可见路径分组，不会丢失原来的目录分类。

项目状态支持继承、显式启用和显式禁用。项目文件夹选中后可按 Ctrl+R 清除目录规则和子项例外，恢复继承。状态通过 Pi 原生 `skills` 与 package filters 保存。插件不会移动或改写 `SKILL.md`。当前进程临时注入的 Skill 只读展示，也不会混入可写文件夹。

## MCP

MCP 不属于这个插件的职责。需要 MCP 时请单独安装和使用官方 `pi-mcp-adapter`。

```bash
pi install npm:pi-mcp-adapter
```

`pi-mcp-adapter` 2.32.1 及以上可通过 `/mcp` 面板或 `/mcp enable <server>`、`/mcp disable <server>` 独立控制 Server。

## 目录

`capability-manager/` 包含 Skill 与文件夹管理界面、资源发现和全局／项目配置写入逻辑。
