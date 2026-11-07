# 异步写入失败与草稿焦点

来源保存或候选提交尚未完成时，用户可以继续编辑表单。此前，失败回执一到，通用错误处理就无条件聚焦反馈区域：正文仍然保留，但输入框失去焦点，接下来的键入无法继续原草稿。

页面现在仍在原有 live region 显示完整错误；仅当焦点已经落到 BODY 时才聚焦反馈区域。用户已主动使用输入框或其他控件时，保持当前焦点与光标位置。项目和 workspace generation 的原有检查保留，旧工作区响应不能更新当前工作区的反馈。

失去焦点时的恢复路径仍保留：反馈区域可聚焦，从那里按 Tab 可到已恢复的提交按钮，再按 Enter 手动重试。结果不确定时，保持内容不变的重试仍复用同一幂等键；不增加自动重试、跨刷新草稿恢复或新权限。

`test/product-experience.js` 新增四项真实 Chromium 回归，使用明确的合成受控回执，无数据库或外部服务。来源和候选各验证一次延迟失败后输入焦点、光标与继续键入；各验证一次 BODY 焦点回退、Tab/Enter 重试、原始提交正文和相同幂等键。修复前，前两项均因焦点被抢而失败。原有 82 项及独立四视口响应式回归继续保留。

```sh
CHROMIUM_PATH=/usr/bin/chromium node --test --test-concurrency=1 test/product-experience.js test/responsive-experience.js
```

未指定 `CHROMIUM_PATH` 时使用 Playwright bundled Chromium。上述检查不代表真实服务端权限、数据库故障或屏幕阅读器验证；错误的可访问性播报沿用既有 `role="status"` live region。
