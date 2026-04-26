import type { TaskFlow, TaskFlowAction, TaskFlowActionId } from '../../utils/taskFlow';

interface Props {
  flow: TaskFlow;
  onAction: (action: TaskFlowActionId) => void;
  /** Extra style for session view stacking */
  style?: React.CSSProperties;
}

export function TaskCard({ flow, onAction, style }: Props) {
  return (
    <article className={`task-card ${flow.mode} ${flow.emphasis}`} style={style}>
      <div className="focus-card-top">
        <div className="card-label">
          {flow.mode === 'focused' && <span className="focus-pulse" />}
          {flow.statusLabel}
        </div>
        <div className="card-title">{flow.title}</div>
        {flow.mode === 'focused' && <div className="focus-timer">In focus - now</div>}
      </div>
      <div className="focus-card-body">
        {flow.kickoff ? (
          <div className="card-kickoff">{flow.kickoff}</div>
        ) : (
          <div className="card-kickoff muted">Add a starting point...</div>
        )}
        {flow.mode === 'focused' && flow.notePreview && (
          <div className="card-notes">
            <div className="detail-section-label">Notes</div>
            {flow.notePreview}
          </div>
        )}
      </div>
      {flow.secondaryActions.some(action => action.id === 'edit') && (
        <button className="card-edit-link" onClick={() => onAction('edit')}>Edit &gt;</button>
      )}
      <div className="card-actions">
        {flow.secondaryActions
          .filter(action => action.id !== 'edit')
          .map(action => (
            <ActionButton key={action.id} action={action} onAction={onAction} />
          ))}
        {flow.primaryAction && <ActionButton action={flow.primaryAction} onAction={onAction} />}
      </div>
    </article>
  );
}

function ActionButton({ action, onAction }: {
  action: TaskFlowAction;
  onAction: (action: TaskFlowActionId) => void;
}) {
  const className = action.tone === 'primary'
    ? 'btn-act'
    : action.tone === 'danger'
      ? 'btn-delete'
      : 'btn-skip';

  return (
    <button className={className} onClick={() => onAction(action.id)}>
      {action.label}
    </button>
  );
}
