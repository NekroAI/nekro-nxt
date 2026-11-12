---
summary: 从安装到在内置频道里和智能体说上第一句话，再把它接进群聊。
ui: [概览, 设置 → 模型, 智能体, 接线]
routes: [/live]
keywords: [安装, 上手, 第一次使用, 新手, 怎么开始, 从哪里开始]
flow: quickstart
---

# 快速开始

第一次用 NekroNXT，照这页走一遍：装好，填一个模型密钥，建一个智能体，在它的内置频道里聊两句，再把它接进你的群聊。全程大约十分钟。

## 1. 安装

- 个人电脑：下载桌面版，步骤见[桌面版安装](../install/desktop.md)。
- 需要长期在线、或者想从多台设备管理：部署服务端，见 [Docker 部署](../install/docker.md)。

打开后看到的是「概览」，提示你先创建智能体。

![第一次打开 NekroNXT 时的概览页](shot:quickstart-welcome)

## 2. 填写模型密钥

智能体要靠大模型思考和说话。NekroNXT 内置了 DeepSeek，只需要填一个 API 密钥：

1. 到 [DeepSeek 开放平台](https://platform.deepseek.com/api_keys)注册并创建 API 密钥，复制下来；
2. 打开「设置 → 模型」，点 DeepSeek；
3. 把密钥粘贴到「API 密钥」，点「保存供应商」。

![在设置里填写 DeepSeek 的 API 密钥](shot:quickstart-model-key)

想用别的模型服务，见[配置模型](../models/providers.md)。

## 3. 创建智能体

回到「概览」，点「创建智能体」：

1. 给它起个名字；
2. 「模型」里默认就是刚配好的 DeepSeek，不用改；
3. 在「设定」里写它是谁、怎么说话、在群里负责什么，几句话就够；
4. 点「创建并开始对话」。

![新建智能体：起名、选模型、写设定](shot:quickstart-new-agent)

「能力」里的读写文件、运行命令等系统访问默认关闭，以后需要时再开。创建后会自动生成它的内置频道，并直接打开。

## 4. 发送第一条消息

在底部输入框里打个招呼，回车发送。智能体回复后，消息上方会显示它这一轮做了什么，比如发了几条消息、用了多久。

![智能体在内置频道里回复了第一条消息](shot:quickstart-first-reply)

想看它的思考过程、工具调用和用量，点频道顶部的「透视」。

## 5. 接进群聊

内置频道只有你自己能看到。要让智能体在 QQ 群、微信等平台里说话，打开「接线」：

```nxt:tour
id: quickstart-wiring-tour
title: 在接线页把群交给智能体
shot: quickstart-wiring
steps:
  - mark: add
    text: 点「添加平台账号」，按平台提示登录或填写凭据。
  - mark: accounts
    text: 连上的账号列在「平台账号」一栏。
  - mark: channels
    text: 账号所在的群和私聊出现在「频道」一栏，内置频道也在这里。
  - mark: agents
    text: 从频道拖一根线到右边「智能体」一栏里的她，她就开始在那个群里说话。
```

各平台的接入方式：

- [QQ 官方机器人](../channels/qq-official.md)：在 QQ 开放平台创建机器人，填 AppID 和 AppSecret；
- [OneBot V11](../channels/onebot-11.md)：连接你自己部署的 SnowLuma、NapCat 或 LLBot；
- [微信 iLink](../channels/wechat-ilink.md)：扫码登录，目前支持私聊；
- 其他平台和接线的完整说明见[连接频道](../channels/wiring.md)。

同一个智能体可以接多个群，每个群的上下文互不相通。

## 接下来

- 让智能体自己写扩展、学新本事：在它的「能力」里打开「动态创造」，然后在频道里描述需求，进展会出现在「工坊」。详见[让她自己做扩展](../extensions/dynamic-creation.md)。
- 遇到问题：先看[排障](../troubleshooting/install.md)。
