import { AnimatePresence, MotionConfig, motion, useIsPresent, type HTMLMotionProps } from 'motion/react'
import { LoaderCircle } from 'lucide-react'
import {
  createContext,
  forwardRef,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react'
import { useMeasuredSelection, type MeasuredSelectionBox } from './measured-selection.js'
import {
  dialogVariants,
  disclosureTransition,
  enterKinds,
  nxtDuration,
  nxtEase,
  overlayVariants,
  popoverVariants,
  themeIconVariants,
  toastVariants,
  tooltipVariants,
  tween,
  type EnterKind,
} from './motion.js'
import styles from './ui.module.css'

export { dialogVariants, enterKinds, overlayVariants, popoverVariants, toastVariants, tooltipVariants, type EnterKind }

const ReducedMotionContext = createContext(false)

export function useNxtReducedMotion(): boolean {
  return useContext(ReducedMotionContext)
}

export function NxtMotionProvider({
  reducedMotion = false,
  children,
}: {
  readonly reducedMotion?: boolean
  readonly children: ReactNode
}) {
  useEffect(() => {
    document.documentElement.dataset['nxtMotion'] = reducedMotion ? 'off' : 'on'
  }, [reducedMotion])
  return (
    <ReducedMotionContext.Provider value={reducedMotion}>
      <MotionConfig
        reducedMotion={reducedMotion ? 'always' : 'never'}
        transition={tween(nxtDuration.standard, nxtEase.enter)}
      >
        {children}
      </MotionConfig>
    </ReducedMotionContext.Provider>
  )
}

export function Presence({
  children,
  mode = 'sync',
  initial = true,
}: {
  readonly children: ReactNode
  readonly mode?: 'sync' | 'wait' | 'popLayout'
  readonly initial?: boolean
}) {
  return (
    <AnimatePresence mode={mode} initial={initial}>
      {children}
    </AnimatePresence>
  )
}

type EnterProps = Omit<HTMLMotionProps<'div'>, 'variants' | 'initial' | 'animate' | 'exit'> & {
  readonly kind?: EnterKind
}

export const Enter = forwardRef<HTMLDivElement, EnterProps>(function Enter({ kind = 'fade', children, ...props }, ref) {
  const reduce = useNxtReducedMotion()
  return (
    <motion.div
      ref={ref}
      {...props}
      data-nxt-enter-kind={kind}
      variants={enterKinds[kind]}
      initial={reduce ? false : 'hidden'}
      animate="visible"
      {...(reduce ? { exit: { opacity: 1, transform: 'none', transition: { duration: 0 } } } : { exit: 'exit' })}
    >
      {children}
    </motion.div>
  )
})

/** Stable message DOM; finished entrances retain no per-frame Motion subscriptions. */
export function MessageEnter({ incoming, children }: { readonly incoming: boolean; readonly children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const animation = useRef<Animation>()
  const reduce = useNxtReducedMotion()
  useLayoutEffect(() => {
    if (!incoming || reduce || !ref.current) return
    animation.current = ref.current.animate(
      [
        { opacity: 0, transform: 'translateY(10px)' },
        { opacity: 1, transform: 'translateY(0)' },
      ],
      { duration: nxtDuration.standard * 1000, easing: `cubic-bezier(${nxtEase.enter.join(',')})` },
    )
    return () => animation.current?.cancel()
  }, [])
  useEffect(() => {
    if (reduce) animation.current?.cancel()
  }, [reduce])
  return (
    <div ref={ref} data-nxt-enter-kind="object">
      {children}
    </div>
  )
}

function StageLayer({ initial, children }: { readonly initial: boolean; readonly children: ReactNode }) {
  const present = useIsPresent()
  const layerRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const layer = layerRef.current
    if (!layer) return
    layer.toggleAttribute('inert', !present)
    if (!present && document.activeElement instanceof HTMLElement && layer.contains(document.activeElement)) {
      document.activeElement.blur()
    }
  }, [present])

  return (
    <motion.div
      ref={layerRef}
      className={styles.stageLayer}
      data-stage-layer={present ? 'in' : 'out'}
      initial={initial ? { opacity: 0, y: 6 } : false}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -4 }}
      transition={present ? tween(nxtDuration.spatial, nxtEase.standard) : tween(nxtDuration.standard, nxtEase.exit)}
      aria-hidden={present ? undefined : true}
    >
      {children}
    </motion.div>
  )
}

export function StageCrossfade({
  swapKey,
  className,
  children,
}: {
  readonly swapKey: string
  readonly className?: string
  readonly children: ReactNode
}) {
  const reduce = useNxtReducedMotion()
  const bootedRef = useRef(false)

  useEffect(() => {
    bootedRef.current = true
  }, [])

  const wrapClass = [styles.stageWrap, className].filter(Boolean).join(' ')
  if (reduce) {
    return (
      <div className={wrapClass} data-route-transition="">
        <div className={styles.stageLayer} data-stage-layer="in">
          {children}
        </div>
      </div>
    )
  }

  return (
    <div className={wrapClass} data-route-transition="">
      <AnimatePresence initial={false}>
        <StageLayer key={swapKey} initial={bootedRef.current}>
          {children}
        </StageLayer>
      </AnimatePresence>
    </div>
  )
}

export function RouteTransition({
  modeKey,
  objectKey,
  className,
  children,
}: {
  readonly modeKey: string
  readonly objectKey: string
  readonly className?: string
  readonly children: ReactNode
}) {
  const routeClass = [styles.fill, className].filter(Boolean).join(' ')
  return (
    <div className={routeClass} data-route-transition-key={`${modeKey}:${objectKey}`}>
      {children}
    </div>
  )
}

const pickNavAnchor = (root: HTMLElement): HTMLElement | null =>
  root.querySelector<HTMLElement>(':scope [data-nav-active]')

const measureNavAnchor = (root: HTMLElement, anchor: HTMLElement): MeasuredSelectionBox => {
  const rootRect = root.getBoundingClientRect()
  const rect = anchor.getBoundingClientRect()
  return {
    x: rect.left - rootRect.left,
    y: rect.top - rootRect.top,
    width: rect.width,
    height: rect.height,
  }
}

const navMutationAttributes = ['data-nav-active'] as const

export function NavMarkGroup({ id, children }: { readonly id: string; readonly children: ReactNode }) {
  const reduce = useNxtReducedMotion()
  const rootRef = useRef<HTMLDivElement>(null)
  const selection = useMeasuredSelection({
    rootRef,
    candidateSelector: '[data-nav-active]',
    mutationAttributeFilter: navMutationAttributes,
    findAnchor: pickNavAnchor,
    measure: measureNavAnchor,
  })
  const box = selection.box

  return (
    <div className={styles.navTrack} data-nav-track={id} ref={rootRef}>
      <motion.span
        className={styles.navMark}
        data-nav-mark={id}
        data-ready={selection.ready ? '' : undefined}
        initial={false}
        animate={{
          x: box?.x ?? 0,
          y: box?.y ?? 0,
          width: box?.width ?? 0,
          height: box?.height ?? 0,
          opacity: selection.ready ? 1 : 0,
        }}
        transition={
          reduce || !selection.animate ? tween(0, nxtEase.standard) : tween(nxtDuration.spatial, nxtEase.standard)
        }
        aria-hidden="true"
      />
      {children}
    </div>
  )
}

export const NavMark: (props: { readonly id: string }) => null = () => null

export function NavGlyph({ active, children }: { readonly active: boolean; readonly children: ReactNode }) {
  return (
    <span className={styles.navGlyph} data-active={active ? '' : undefined}>
      {children}
    </span>
  )
}

export function Disclosure({
  open,
  className,
  children,
}: {
  readonly open: boolean
  readonly className?: string
  readonly children: ReactNode
}) {
  const reduce = useNxtReducedMotion()
  return (
    <AnimatePresence initial={false}>
      {open ? (
        <motion.div
          key="disclosure"
          className={className}
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: 'auto', opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={reduce ? { duration: 0 } : disclosureTransition}
          style={{ overflow: 'hidden' }}
          aria-hidden={!open}
        >
          {children}
        </motion.div>
      ) : null}
    </AnimatePresence>
  )
}

export function SidePane({
  collapsed,
  width,
  widthVariable,
  rootRef,
  onSettled,
  className,
  children,
}: {
  readonly collapsed: boolean
  readonly width: number
  readonly widthVariable?: string
  readonly rootRef?: RefObject<HTMLDivElement>
  readonly onSettled?: (collapsed: boolean) => void
  readonly className?: string
  readonly children: ReactNode
}) {
  const reduce = useNxtReducedMotion()
  const paneWidth = widthVariable ? `var(${widthVariable}, ${width}px)` : `${width}px`
  return (
    <motion.div
      ref={rootRef}
      className={className}
      initial={false}
      animate={{
        '--nxt-pane-progress': collapsed ? 0 : 1,
        opacity: collapsed ? 0 : 1,
        x: collapsed ? 12 : 0,
        visibility: 'visible',
        ...(collapsed ? { transitionEnd: { visibility: 'hidden' } } : {}),
      }}
      transition={
        reduce
          ? tween(0, nxtEase.standard)
          : tween(collapsed ? nxtDuration.standard : nxtDuration.spatial, collapsed ? nxtEase.exit : nxtEase.standard)
      }
      onAnimationComplete={() => onSettled?.(collapsed)}
      style={{
        ...(widthVariable ? { [widthVariable]: `${width}px` } : {}),
        width: `calc(${paneWidth} * var(--nxt-pane-progress, ${collapsed ? 0 : 1}))`,
        overflow: 'hidden',
        pointerEvents: collapsed ? 'none' : 'auto',
        flexShrink: 0,
      }}
      aria-hidden={collapsed}
    >
      <div style={{ width: paneWidth, height: '100%', minHeight: 0 }}>{children}</div>
    </motion.div>
  )
}

export function ThemeIconSwap({ swapKey, children }: { readonly swapKey: string; readonly children: ReactNode }) {
  const reduce = useNxtReducedMotion()
  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.span
        key={swapKey}
        className={styles.themeIcon}
        variants={themeIconVariants}
        initial={reduce ? false : 'hidden'}
        animate="visible"
        {...(reduce ? { exit: { opacity: 1, rotate: 0, scale: 1, transition: { duration: 0 } } } : { exit: 'exit' })}
      >
        {children}
      </motion.span>
    </AnimatePresence>
  )
}

export function Spinner({
  delayMs = 300,
  size = 15,
  className,
}: {
  readonly delayMs?: number
  readonly size?: number
  readonly className?: string
}) {
  const [visible, setVisible] = useState(delayMs <= 0)
  useEffect(() => {
    if (delayMs <= 0) {
      setVisible(true)
      return
    }
    setVisible(false)
    const timer = window.setTimeout(() => setVisible(true), delayMs)
    return () => window.clearTimeout(timer)
  }, [delayMs])
  if (!visible) return null
  return (
    <LoaderCircle
      className={[styles.loadingSpinner, className].filter(Boolean).join(' ')}
      size={size}
      aria-hidden="true"
    />
  )
}

export type AgentVisualState = 'idle' | 'thinking' | 'using-tool' | 'waiting-input' | 'unavailable'

const ringTone = (state: AgentVisualState): string => {
  if (state === 'thinking' || state === 'using-tool') return styles.ringInfo
  if (state === 'waiting-input') return styles.ringInfo
  if (state === 'unavailable') return styles.ringDanger
  return styles.ringNeutral
}

export function AgentStateRing({ state, label }: { readonly state: AgentVisualState; readonly label: string }) {
  const reduce = useNxtReducedMotion()
  const thinking = state === 'thinking' && !reduce
  const tooling = state === 'using-tool' && !reduce
  return (
    <motion.span
      className={[styles.stateRing, ringTone(state)].join(' ')}
      aria-label={label}
      initial={false}
      animate={thinking ? { opacity: [0.45, 1, 0.45] } : tooling ? { rotate: 360 } : { opacity: 1, rotate: 0 }}
      transition={
        thinking
          ? { duration: 1.6, repeat: Infinity, ease: 'easeInOut' }
          : tooling
            ? { duration: 2.4, repeat: Infinity, ease: 'linear' }
            : { duration: nxtDuration.fast }
      }
    />
  )
}
