interface Props {
  message: string;
}

export function EmptyState({ message }: Props) {
  return <div className="empty">{message}</div>;
}
