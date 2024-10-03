import { render } from 'preact';
import { App } from './App';
import './stats.css';

render(<App />, document.getElementById('app') as HTMLElement);
