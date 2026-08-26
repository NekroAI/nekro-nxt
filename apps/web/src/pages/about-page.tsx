import type { ReactNode } from 'react'
import type { ProductMetadataView } from '../product-store.js'
import styles from './about-page.module.css'

const compiledProductVersion = typeof __NEKRO_PRODUCT_VERSION__ === 'string' ? __NEKRO_PRODUCT_VERSION__ : ''

const fallbackMetadata = {
  displayName: 'NekroNXT',
  organizationName: 'NekroAI',
  version: compiledProductVersion,
  repositoryUrl: 'https://github.com/NekroAI/nekro-nxt',
  licenseSpdx: 'AGPL-3.0-only',
} as const

function Fact({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className={styles.fact}>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  )
}

export function AboutPage({ metadata }: { readonly metadata?: Partial<ProductMetadataView> | undefined }) {
  const product = {
    displayName: metadata?.displayName?.trim() || fallbackMetadata.displayName,
    organizationName: metadata?.organizationName?.trim() || fallbackMetadata.organizationName,
    version: metadata?.version?.trim() || fallbackMetadata.version,
    releaseId: metadata?.releaseId?.trim() || '',
    repositoryUrl: metadata?.repositoryUrl?.trim() || fallbackMetadata.repositoryUrl,
    licenseSpdx: metadata?.licenseSpdx?.trim() || fallbackMetadata.licenseSpdx,
    dshVersion: metadata?.dshVersion?.trim() || '',
  }
  return (
    <section className={styles.about} aria-label="关于 NekroNXT">
      <div className={styles.hero}>
        <img src="/brand/mark.svg" alt="NekroNXT Logo" />
        <div>
          <span>NekroAI · NXT</span>
          <h2>{product.displayName}</h2>
          <p>以 DSH 为核心引擎，原生面向群聊与动态扩展的智能体聊天系统。</p>
        </div>
      </div>

      <dl className={styles.facts}>
        <Fact label="项目组织">
          <a href="https://github.com/NekroAI" target="_blank" rel="noreferrer">
            {product.organizationName}
          </a>
        </Fact>
        <Fact label="软件版本">{product.version || '暂无'}</Fact>
        <Fact label="开源仓库">
          <a href={product.repositoryUrl} target="_blank" rel="noreferrer">
            NekroAI/nekro-nxt
          </a>
        </Fact>
        <Fact label="DSH 版本">{product.dshVersion || '暂无'}</Fact>
        <Fact label="开源许可证">
          <a href="https://github.com/NekroAI/nekro-nxt/blob/main/LICENSE" target="_blank" rel="noreferrer">
            {product.licenseSpdx}
          </a>
        </Fact>
        <Fact label="Release ID">{product.releaseId || '暂无'}</Fact>
      </dl>

      <div className={styles.notice}>
        <strong>版权与品牌</strong>
        <p>
          代码版权归 NekroAI contributors，并按 GNU AGPL v3.0
          授权，在适用法律允许范围内不提供担保。Logo、水月荧、角色插画和宣传素材版权归 NekroAI，且不属于代码许可证。
        </p>
        <div className={styles.links}>
          <a href="https://github.com/NekroAI/nekro-nxt/blob/main/NOTICE" target="_blank" rel="noreferrer">
            版权声明
          </a>
          <a href="https://github.com/NekroAI/nekro-nxt/blob/main/docs/BRAND.md" target="_blank" rel="noreferrer">
            品牌规范
          </a>
          <a href="https://github.com/NekroAI/nekro-nxt/security" target="_blank" rel="noreferrer">
            安全报告
          </a>
        </div>
      </div>
    </section>
  )
}
