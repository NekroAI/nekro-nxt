import { useEffect, useState } from 'react'
import { COMMUNITY_PERSONA_AVATAR_MAX_BYTES, HostApiContracts, type CommunityPersonaDetail } from '@nekro-nxt/contracts'
import { callHostApi } from '../../host-api-client.js'
import { errorMessage } from './community-model.js'

/** 与工作台布局一致：1100px 以下列表栏收起，人设详情改为整页。 */
const WIDE_QUERY = '(min-width: 1100px)'

export const useWideLayout = (): boolean => {
  const [wide, setWide] = useState(() =>
    typeof window === 'undefined' || !window.matchMedia ? true : window.matchMedia(WIDE_QUERY).matches,
  )
  useEffect(() => {
    if (!window.matchMedia) return
    const query = window.matchMedia(WIDE_QUERY)
    const update = () => setWide(query.matches)
    update()
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])
  return wide
}

export const usePersonaDetail = (personaId: string) => {
  const [detail, setDetail] = useState<CommunityPersonaDetail>()
  const [error, setError] = useState<string>()
  useEffect(() => {
    let cancelled = false
    setDetail(undefined)
    setError(undefined)
    callHostApi(HostApiContracts.getCommunityPersona, { personaId }, undefined)
      .then((result) => {
        if (!cancelled) setDetail(result)
      })
      .catch((caught: unknown) => {
        if (!cancelled) setError(errorMessage(caught))
      })
    return () => {
      cancelled = true
    }
  }, [personaId])
  return { detail, error }
}

/** 「温柔, 图书 ，陪伴」→ 去重后的标签。 */
export const parseTags = (value: string): string[] => [
  ...new Set(
    value
      .split(/[,，、\s]+/u)
      .map((tag) => tag.trim().slice(0, 40))
      .filter(Boolean),
  ),
]

const loadImage = (url: string): Promise<HTMLImageElement> =>
  new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('头像读取失败。'))
    image.src = url
  })

const toBlob = (canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> =>
  new Promise((resolve) => canvas.toBlob(resolve, type, quality))

const acceptedType = (type: string) =>
  type === 'image/webp' || type === 'image/png' || type === 'image/jpeg' ? type : undefined

/**
 * 把智能体头像缩放成适合分享的方图（最长边 512px，必要时再缩小），编码为 WebP；浏览器不支持时退回 PNG。
 * 结果不超过社区的 512 KiB 上限。
 */
export const prepareShareAvatar = async (
  url: string,
): Promise<{ readonly mediaType: 'image/png' | 'image/jpeg' | 'image/webp'; readonly base64: string }> => {
  const image = await loadImage(url)
  for (const edge of [512, 384, 256]) {
    const scale = Math.min(1, edge / Math.max(image.naturalWidth, image.naturalHeight, 1))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale))
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale))
    canvas.getContext('2d')?.drawImage(image, 0, 0, canvas.width, canvas.height)
    const blob = (await toBlob(canvas, 'image/webp', 0.9)) ?? (await toBlob(canvas, 'image/png'))
    const mediaType = blob ? acceptedType(blob.type) : undefined
    if (!blob || !mediaType || blob.size > COMMUNITY_PERSONA_AVATAR_MAX_BYTES) continue
    const bytes = new Uint8Array(await blob.arrayBuffer())
    let binary = ''
    for (let index = 0; index < bytes.length; index += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
    }
    return { mediaType, base64: btoa(binary) }
  }
  throw new Error('头像太大，无法分享。')
}
