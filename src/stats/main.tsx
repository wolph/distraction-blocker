import { render } from 'preact';
import { App } from './App';
import '../shared/settings-nav.css';
import '../shared/theme-control.css';
import './stats.css';

render(<App />, document.getElementById('app') as HTMLElement);
