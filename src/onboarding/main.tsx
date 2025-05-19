import { render } from 'preact';
import { App } from './App';
import './onboarding.css';

render(<App />, document.getElementById('app') as HTMLElement);
