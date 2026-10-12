import { readFile } from 'node:fs/promises'
import { HostApiContracts } from '@nekro-nxt/contracts'
import { expect, test } from '@playwright/test'

// Both files are synthetic: silent PCM audio and a solid-color VP8 clip generated for this test.
for (const theme of ['light', 'dark'] as const) {
  test(`forwarded files download and recordings/videos play in ${theme}`, async ({ page, request }, testInfo) => {
    const failures: string[] = []
    page.on('pageerror', (error) => failures.push(error.message))
    await page.setViewportSize({ width: theme === 'light' ? 1440 : 1100, height: 900 })
    await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' })
    await page.addInitScript((value) => localStorage.setItem('nekro-nxt.theme', value), theme)
    const created = await request.post('/api/channels', { data: { displayName: '转发附件验收' } })
    const { channelId } = HostApiContracts.createInternalChannel.response.parse(await created.json())
    expect(
      (
        await request.post(`/api/channels/${channelId}/messages`, {
          data: { clientEventId: `fixture-download-${theme}`, parts: [{ type: 'text', text: '虚构附件' }] },
        })
      ).ok(),
    ).toBe(true)
    await page.route(`**/api/channels/${channelId}/messages**`, async (route) => {
      const response = await route.fetch()
      const body = HostApiContracts.listChannelMessages.response.parse(await response.json())
      await route.fulfill({
        json: {
          ...body,
          messages: body.messages.map((message) => ({
            ...message,
            parts: [
              {
                type: 'rich',
                adapterKey: 'onebot-11',
                kind: 'forward',
                summary: '合并转发消息（1 个节点）。',
                extension: {
                  items: [
                    { sender: '虚构成员', text: '文件、语音和视频均为验收样本。' },
                    { fileAssetId: 'ast_forwardText', fileName: '虚构资料.txt', fileMediaType: 'text/plain' },
                    { audioAssetId: 'ast_forwardVoice' },
                    { fileAssetId: 'ast_forwardVideo', fileName: '虚构短片.webm', fileMediaType: 'video/webm' },
                    { fileAssetId: 'ast_forwardBroken', fileName: '损坏媒体.webm', fileMediaType: 'video/webm' },
                  ],
                },
              },
            ],
          })),
        },
      })
    })
    const audio = await readFile(new URL('./fixtures/forward-voice.wav', import.meta.url))
    const video = await readFile(new URL('./fixtures/forward-video.webm', import.meta.url))
    await page.route(`**/api/channels/${channelId}/assets/ast_forward*`, (route) => {
      const url = route.request().url()
      return url.endsWith('Voice')
        ? route.fulfill({ contentType: 'audio/wav', body: audio })
        : url.endsWith('Video')
          ? route.fulfill({ contentType: 'video/webm', body: video })
          : url.endsWith('Broken')
            ? route.fulfill({ contentType: 'video/webm', body: 'synthetic invalid media' })
            : route.fulfill({ contentType: 'text/plain; charset=utf-8', body: '这是虚构的转发文件内容。' })
    })
    await page.goto(`/channels/${channelId}`)
    await expect(page.getByRole('button', { name: '虚构资料.txt', exact: true })).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath(`attachments-${theme}.png`), animations: 'disabled' })
    await page.getByRole('button', { name: '虚构资料.txt', exact: true }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByText('这是虚构的转发文件内容。', { exact: true })).toBeVisible()
    const download = page.waitForEvent('download')
    await dialog.getByRole('link', { name: '下载' }).click()
    expect((await download).suggestedFilename()).toBe('虚构资料.txt')
    await page.getByRole('button', { name: '关闭预览' }).click()
    for (const [name, tag] of [
      ['播放语音', 'audio'],
      ['虚构短片.webm', 'video'],
    ] as const) {
      await page.getByRole('button', { name, exact: true }).click()
      const player = dialog.locator(tag)
      await expect
        .poll(() => player.evaluate((element) => element instanceof HTMLMediaElement && element.readyState >= 1))
        .toBe(true)
      await player.evaluate(async (element) => {
        if (element instanceof HTMLMediaElement) {
          element.muted = true
          await element.play()
        }
      })
      await expect
        .poll(() => player.evaluate((element) => (element instanceof HTMLMediaElement ? element.currentTime : 0)))
        .toBeGreaterThan(0)
      await page.screenshot({ path: testInfo.outputPath(`${tag}-${theme}.png`), animations: 'disabled' })
      await page.getByRole('button', { name: '关闭预览' }).click()
    }
    await page.getByRole('button', { name: '损坏媒体.webm', exact: true }).click()
    await expect(dialog.getByText('浏览器无法播放此文件，可以下载后查看。')).toBeVisible()
    await expect(dialog.getByRole('link', { name: '下载' })).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath(`unsupported-media-${theme}.png`), animations: 'disabled' })
    expect(failures).toEqual([])
  })
}
