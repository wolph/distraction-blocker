import { render } from 'preact';
import { App } from './App';
import '../shared/theme-control.css';
import './popup.css';

render(<App />, document.getElementById('app') as HTMLElement);
