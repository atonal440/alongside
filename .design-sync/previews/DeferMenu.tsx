import { DeferMenu } from 'alongside-pwa';

export function WithTitle() {
  return (
    <div style={{ width: 260, padding: 16 }}>
      <DeferMenu
        taskTitle="Review open pull requests"
        onChoose={() => {}}
        onCancel={() => {}}
      />
    </div>
  );
}

export function NoTitle() {
  return (
    <div style={{ width: 260, padding: 16 }}>
      <DeferMenu
        onChoose={() => {}}
        onCancel={() => {}}
      />
    </div>
  );
}
