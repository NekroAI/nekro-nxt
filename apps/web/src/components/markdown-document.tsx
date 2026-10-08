import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown'
import rehypeSanitize from 'rehype-sanitize'
import remarkGfm from 'remark-gfm'
import styles from './markdown-document.module.css'

const urlTransform = (url: string): string => {
  const transformed = defaultUrlTransform(url)
  return /^(https?:|mailto:)/iu.test(transformed) ? transformed : ''
}

const components: Components = {
  a: ({ children, ...props }) => (
    <a {...props} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ),
  // 作者写的表格可能很宽：外面套一层可横向滚动的容器，不撑破页面。
  table: ({ children }) => (
    <div className={styles.tableWrap}>
      <table>{children}</table>
    </div>
  ),
}

/**
 * 作者写的长篇说明（社区扩展与人设的介绍）：按文档排版，而不是聊天消息的紧凑样式。
 * GitHub 风格（表格、任务列表、删除线），不渲染 HTML；只保留 http(s) 与 mailto 链接，不加载外部图片。
 */
export function MarkdownDocument({ text }: { readonly text: string }) {
  return (
    <div className={styles.document}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeSanitize]}
        skipHtml
        urlTransform={urlTransform}
        components={components}
        disallowedElements={['img']}
        unwrapDisallowed
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}
