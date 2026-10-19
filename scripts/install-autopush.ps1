# 安装 post-commit 钩子：提交后自动 push 当前 main 到 origin。
# 删除 .git/hooks/post-commit 即可停用。
$ErrorActionPreference = "Stop"
$gitDir = (git rev-parse --git-dir).Trim()
$hook = Join-Path $gitDir "hooks/post-commit"
$content = @'
#!/bin/sh
# 自动推送 main 到 origin（DSH 配置；删除本文件即可停用）
branch=$(git symbolic-ref --short HEAD 2>/dev/null) || exit 0
[ "$branch" = "main" ] || exit 0
git push origin main >/dev/null 2>&1
'@
$content = $content -replace "`r`n", "`n"
[System.IO.File]::WriteAllText($hook, $content)
Write-Host "installed: $hook"
