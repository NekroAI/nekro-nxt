import type { HostUiKit } from '@nekro-nxt/extension-sdk'
import * as React from 'react'
import type { ReactNode } from 'react'
import {
  Banner,
  Button,
  Chip,
  Dialog,
  EmptyState as KitEmptyState,
  Field,
  IconButton,
  Input,
  Popover,
  PropertyList,
  PropertyRow,
  Select,
  Spinner,
  Switch,
  TabStrip,
  Textarea,
  Tooltip,
  type Tone,
} from '../ui-kit/index.js'
import styles from './ui-kit.module.css'

/**
 * Wraps a kit component so verification can see which kit components a contribution rendered
 * (`data-nxt-ui-component`), without changing the component's own layout.
 */
const marked = (name: string, Component: React.ElementType): React.ElementType => {
  const Marked = React.forwardRef<unknown, Readonly<Record<string, unknown>>>((props, ref) => (
    <div className={styles.uiComponentMarker} data-nxt-ui-component={name}>
      <Component {...props} ref={ref} />
    </div>
  ))
  Marked.displayName = `ExtensionUi${name}`
  return Marked
}

type StatusTone = 'neutral' | 'success' | 'warning' | 'error' | 'info'

const statusTone: Record<StatusTone, Tone> = {
  neutral: 'neutral',
  success: 'ok',
  warning: 'warn',
  error: 'bad',
  info: 'accent',
}

/** A short state label in the product's status colours; `tone` keeps the extension vocabulary. */
function StatusBadge({ tone = 'neutral', children }: { readonly tone?: StatusTone; readonly children?: ReactNode }) {
  return (
    <Chip tone={statusTone[tone] ?? 'neutral'} dot>
      {children}
    </Chip>
  )
}

const feedbackTone = { info: 'info', success: 'ok', warning: 'warn', error: 'bad' } as const

/** An inline result or problem inside the contribution. */
function InlineFeedback({
  tone = 'info',
  children,
  action,
}: {
  readonly tone?: keyof typeof feedbackTone
  readonly children?: ReactNode
  readonly action?: ReactNode
}) {
  return (
    <Banner tone={feedbackTone[tone] ?? 'info'} action={action}>
      {children}
    </Banner>
  )
}

/** Nothing to show yet, with what to do next. `loading` replaces the icon while data arrives. */
function EmptyState({
  title,
  description,
  action,
  loading = false,
}: {
  readonly title: ReactNode
  readonly description?: ReactNode
  readonly action?: ReactNode
  readonly loading?: boolean
}) {
  return (
    <KitEmptyState title={title} action={action} {...(loading ? { icon: <Spinner /> } : {})}>
      {description}
    </KitEmptyState>
  )
}

/** Title block of an extension page. The Host draws the frame; this only names the content. */
function PageHeader({
  title,
  meta,
  actions,
}: {
  readonly title: ReactNode
  readonly meta?: ReactNode
  readonly actions?: ReactNode
}) {
  return (
    <header className={styles.pageHeader} data-page-header="">
      <div className={styles.pageHeaderText}>
        <h1>{title}</h1>
        {meta ? <p>{meta}</p> : null}
      </div>
      {actions ? <div className={styles.pageHeaderActions}>{actions}</div> : null}
    </header>
  )
}

/** `ui-kit@2`: the redesigned component surface every panel, tool view, message renderer and page renders with. */
export const extensionUiKit: HostUiKit = {
  version: 'ui-kit@2',
  Button: marked('Button', Button),
  IconButton: marked('IconButton', IconButton),
  Input: marked('Input', Input),
  Textarea: marked('Textarea', Textarea),
  Select: marked('Select', Select),
  Switch: marked('Switch', Switch),
  Tabs: marked('Tabs', TabStrip),
  Dialog: marked('Dialog', Dialog),
  Popover: marked('Popover', Popover),
  Tooltip: marked('Tooltip', Tooltip),
  Field: marked('Field', Field),
  StatusBadge: marked('StatusBadge', StatusBadge),
  InlineFeedback: marked('InlineFeedback', InlineFeedback),
  EmptyState: marked('EmptyState', EmptyState),
  Spinner: marked('Spinner', Spinner),
  PageHeader: marked('PageHeader', PageHeader),
  MetricStrip: (props: { readonly children?: ReactNode }) => (
    <div className={styles.metricStrip} data-nxt-ui-component="MetricStrip">
      {props.children}
    </div>
  ),
  Metric: (props: { readonly label?: ReactNode; readonly value?: ReactNode; readonly detail?: ReactNode }) => (
    <div className={styles.metric} data-nxt-ui-component="Metric">
      <span>{props.label}</span>
      <strong>{props.value}</strong>
      {props.detail === undefined ? null : <small>{props.detail}</small>}
    </div>
  ),
  Section: (props: { readonly title?: ReactNode; readonly children?: ReactNode }) => (
    <section className={styles.section} data-nxt-ui-component="Section">
      {props.title ? <h2 className={styles.sectionTitle}>{props.title}</h2> : null}
      {props.children}
    </section>
  ),
  Stack: (props: { readonly children?: ReactNode }) => (
    <div className={styles.stack} data-nxt-ui-component="Stack">
      {props.children}
    </div>
  ),
  Grid: (props: { readonly children?: ReactNode }) => (
    <div className={styles.grid} data-nxt-ui-component="Grid">
      {props.children}
    </div>
  ),
  DataTable: (props: { readonly children?: ReactNode }) => (
    <div className={styles.tableScroll} data-nxt-ui-component="DataTable">
      <table>{props.children}</table>
    </div>
  ),
  PropertyList: marked('PropertyList', PropertyList),
  PropertyRow: marked('PropertyRow', PropertyRow),
}

/** React surface handed to Client factories; only the documented hooks are exposed. */
export const extensionReactFacade = {
  createElement: (type: React.ElementType, props?: object | null, ...children: ReactNode[]) =>
    React.createElement(type, props, ...children),
  Fragment: React.Fragment,
  useState: React.useState,
  useEffect: React.useEffect,
  useMemo: React.useMemo,
  useCallback: React.useCallback,
  useRef: React.useRef,
  useSyncExternalStore: React.useSyncExternalStore,
}
