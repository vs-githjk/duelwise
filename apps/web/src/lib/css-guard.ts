/**
 * Last line of defence against an unstyled page. If the document loaded but the app stylesheet did not apply (a page and its files
 * from different deploys, a stylesheet answered with an error page), this reloads once with the service worker out of the way:
 * it unregisters the workers, deletes the Duelwise caches, and reloads. The stylesheet declares --dw-css (styles/app.css) so the
 * check is exact. It is inline in the document head so it still runs when every script file failed to load. It does nothing when
 * session storage is unavailable (it could not remember that it already tried) and clears its mark once the page is styled.
 */
export const CSS_MARK_VAR = '--dw-css'
export const CSS_RELOAD_KEY = 'duelwise.css-reload'

export const CSS_GUARD_SCRIPT = `(function(){
function styled(){try{return getComputedStyle(document.documentElement).getPropertyValue('${CSS_MARK_VAR}').trim()==='1'}catch(e){return true}}
function check(){
  var s;try{s=window.sessionStorage;s.getItem('${CSS_RELOAD_KEY}')}catch(e){return}
  if(styled()){try{s.removeItem('${CSS_RELOAD_KEY}')}catch(e){}return}
  try{if(s.getItem('${CSS_RELOAD_KEY}'))return;s.setItem('${CSS_RELOAD_KEY}','1')}catch(e){return}
  var jobs=[];
  try{if(navigator.serviceWorker&&navigator.serviceWorker.getRegistrations)jobs.push(navigator.serviceWorker.getRegistrations().then(function(r){return Promise.all(r.map(function(x){return x.unregister()}))}))}catch(e){}
  try{if(window.caches)jobs.push(caches.keys().then(function(n){return Promise.all(n.filter(function(x){return x.indexOf('duelwise-')===0}).map(function(x){return caches.delete(x)}))}))}catch(e){}
  Promise.all(jobs.map(function(p){return p.catch(function(){})})).then(function(){location.reload()},function(){location.reload()})
}
window.addEventListener('load',function(){setTimeout(check,1200)})
})()`
