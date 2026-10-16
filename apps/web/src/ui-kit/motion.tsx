import { cssVars } from './css-vars.js'
import type { PointerEvent } from 'react'
import styles from './motion.module.css'

/**
 * One-shot entrance for a heading on a low-frequency page (05 §11.5): characters rise out of a soft blur in turn. The
 * whole entrance stays under 800ms; screen readers get the plain text once.
 */
export function RevealText({ text, className }: { readonly text: string; readonly className?: string }) {
  const characters = [...text]
  // Spread the stagger so long titles still finish inside the budget.
  const step = Math.min(28, 300 / Math.max(1, characters.length))
  return (
    <span className={[styles.reveal, className ?? ''].join(' ')} aria-label={text}>
      {characters.map((character, index) => (
        <span
          key={index}
          className={styles.revealChar}
          style={cssVars({ '--delay': `${Math.round(index * step)}ms` })}
          aria-hidden="true"
        >
          {character === ' ' ? ' ' : character}
        </span>
      ))}
    </span>
  )
}

/** Text with a light sweep, for labels of work that is actually in progress (“思考中”, “正在验证”). */
export function ShimmerText({ children, className }: { readonly children: string; readonly className?: string }) {
  return <span className={[styles.shimmer, className ?? ''].join(' ')}>{children}</span>
}

const trackSpotlight = (event: PointerEvent<HTMLElement>) => {
  const box = event.currentTarget.getBoundingClientRect()
  event.currentTarget.style.setProperty('--spot-x', `${event.clientX - box.left}px`)
  event.currentTarget.style.setProperty('--spot-y', `${event.clientY - box.top}px`)
}

/**
 * Showcase cards (community, personas) catch a soft light under the pointer. Spread onto the card element; the card
 * needs no positioning of its own.
 */
export const spotlight = { className: styles.spotlight, onPointerMove: trackSpotlight } as const
