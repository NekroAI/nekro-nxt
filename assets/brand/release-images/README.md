# Release 临时配图

`current/` 保存下一次正式发布专用的临时配图。图片随发布 Commit 固化到 GitHub Release；发布完成并开始准备下一版本后，清空或替换 `current/`。

临时配图使用虚构数据，导入后清除 EXIF、XMP 与 IPTC 元数据。执行 `pnpm brand:export && pnpm brand:check` 更新并验证品牌资产清单。
