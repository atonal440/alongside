import { Markdown } from 'alongside-pwa';

export function Paragraph() {
  return <Markdown src="Write down what's on your mind. Keep it simple and concrete." />;
}

export function Formatted() {
  return (
    <Markdown src={`**Focus** on the next step, not the whole project.\n\nBreak it into _small, concrete actions_ that move things forward.`} />
  );
}

export function WithList() {
  return (
    <Markdown src={`## Today's plan\n\n- Review open pull requests\n- Write the first draft\n- Follow up with the team\n- Clear the inbox`} />
  );
}

export function WithCode() {
  return (
    <Markdown src={"Set up the dev environment:\n\n```\nnpm install && npm run dev\n```\n\nThen open `http://localhost:5173` in your browser."} />
  );
}
