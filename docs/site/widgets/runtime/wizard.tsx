/** @jsxImportSource preact */
import { useState } from 'preact/hooks'
import type { Mode, WizardData } from './types.js'

/**
 * 排查向导: one question at a time; each answer leads to the next question or to what to do. The answers so far stay
 * above it, and picking one goes back there. Posters show the first question.
 */
export const Wizard = ({ title, data, mode }: { title: string; data: WizardData; mode: Mode }) => {
  const first = data.steps[0]
  // The path taken: each question with the label chosen.
  const [path, setPath] = useState<readonly { readonly step: string; readonly label: string }[]>([])
  const byId = new Map(data.steps.map((step) => [step.id, step]))
  const lastChoice = path.at(-1)
  const currentId =
    lastChoice === undefined
      ? first?.id
      : (() => {
          const step = byId.get(lastChoice.step)
          return step !== undefined && 'choices' in step
            ? step.choices.find((choice) => choice.label === lastChoice.label)?.next
            : undefined
        })()
  const current = currentId === undefined ? undefined : byId.get(currentId)
  if (current === undefined) return null

  return (
    <figure class="card" style={{ margin: 0 }} aria-label={`排查向导：${title}`}>
      <div class="head">
        <p class="title">
          <span class="kind">排查向导</span>
          {title}
        </p>
        {mode.kind === 'live' && path.length > 0 ? (
          <button type="button" class="control" onClick={() => setPath([])}>
            重来
          </button>
        ) : null}
      </div>
      {path.length === 0 ? null : (
        <ol class="trail">
          {path.map((taken, index) => {
            const step = byId.get(taken.step)
            return step === undefined || !('ask' in step) ? null : (
              <li key={taken.step}>
                <button type="button" class="taken" onClick={() => setPath(path.slice(0, index))} title="回到这一问">
                  <span>{step.ask}</span>
                  <b>{taken.label}</b>
                </button>
              </li>
            )
          })}
        </ol>
      )}
      <div class="ask" aria-live="polite" key={current.id}>
        {'ask' in current ? (
          <>
            <p class="question">{current.ask}</p>
            <div class="choices">
              {current.choices.map((choice) => (
                <button
                  key={choice.label}
                  type="button"
                  class="choice"
                  onClick={() => setPath([...path, { step: current.id, label: choice.label }])}
                >
                  {choice.label}
                </button>
              ))}
            </div>
          </>
        ) : (
          <div class="answer">
            <p>{current.answer}</p>
            {current.link === undefined ? null : (
              <a href={current.link} target="_top">
                查看详细说明 →
              </a>
            )}
          </div>
        )}
      </div>
    </figure>
  )
}
