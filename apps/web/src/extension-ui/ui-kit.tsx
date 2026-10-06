import type { HostUiKit } from '@nekro-nxt/extension-sdk'
import * as React from 'react'
import type { ReactNode } from 'react'
import { EmptyState, InlineFeedback, PageHeader } from '../components/product-feedback.js'
import {
  Button,
  Dialog,
  DropdownMenu,
  Field,
  IconButton,
  Input,
  SelectField,
  SidePane,
  Spinner,
  StatusBadge,
  SwitchControl,
  Tabs,
  Textarea,
  Tooltip,
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

/** `ui-kit@1`: the versioned component surface every panel, tool view, message renderer and page renders with. */
export const extensionUiKit: HostUiKit = {
  version: 'ui-kit@1',
  Button: marked('Button', Button),
  IconButton: marked('IconButton', IconButton),
  Input: marked('Input', Input),
  Textarea: marked('Textarea', Textarea),
  Select: marked('Select', SelectField),
  Switch: marked('Switch', SwitchControl),
  Tabs,
  Dialog: marked('Dialog', Dialog),
  Popover: DropdownMenu,
  Tooltip,
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
  Section: (props: { readonly children?: ReactNode }) => (
    <section className={styles.section} data-nxt-ui-component="Section">
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
  SidePane: marked('SidePane', SidePane),
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
