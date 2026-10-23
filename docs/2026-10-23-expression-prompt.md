# 表情生成 Prompt（固定模板）

用途：让画图模型生成与现有小鲸表情同规格的新表情。每次生成新表情前，先复制本模板，只替换「表情描述」。

## 正向 Prompt

```text
蓝发鲸娘女仆，Q 版全身，正面坐姿，和现有表情同一角色、同一画风、同一比例、同一构图；
表情：[在这里写表情，例如“困惑地歪头，一只手托腮，旁边一个蓝色问号”]；
干净的黑色线稿描边，平涂上色，柔和阴影；
纯透明背景；
角色外轮廓必须是黑色描边，描边外侧不能有任何白色、米白色、浅蓝色或半透明的白边；
白色衣服和蕾丝可以保留，但只能存在于黑色轮廓内部；
画面居中，完整露出头部、头发、身体和裙摆，不裁切；
正方形 PNG，无文字、无水印、无装饰边框、无贴纸底板。
```

## 必须写进负面 Prompt 的词

```text
白色描边，白色外圈，白边，白色光晕，贴纸白边，白色底板，米白色轮廓，浅蓝色轮廓，半透明白边，抠图残留，白底，文字，水印，边框，裁切，比例不一致，画风不一致
```

英文补充：

```text
no white outline, no white halo, no white sticker border, no off-white fringe, no light-blue fringe, no semi-transparent white edge, transparent background only, keep the black line art, do not crop the character, no text, no watermark, no border
```

## 生成后检查

1. 把图放到深色背景上看外轮廓，不能出现一圈白线或浅色过渡。
2. 黑色描边必须连续；衣服、蕾丝、皮肤内部的白色不能一起被删掉。
3. 角色大小和现有 `focus.png` / `surprise.png` 接近，底部不要被裁。
4. 确认后再交给我做去白边和接入。
