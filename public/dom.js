const markup = new WeakMap();
const lists = new WeakMap();

function focusSelector(element){
  const identity=Array.from(element.attributes).filter(attribute=>attribute.name==='id'||attribute.name==='aria-label'||attribute.name==='href'||attribute.name.startsWith('data-'));
  return identity.length?element.tagName.toLowerCase()+identity.map(attribute=>`[${CSS.escape(attribute.name)}="${CSS.escape(attribute.value)}"]`).join(''):null;
}

// HTML serialization normalizes some attributes, so compare the original input
// while checking that the current DOM still belongs to that render.
export function updateHTML(element,html){
  const previous=markup.get(element);
  if(previous?.html===html&&previous.first===element.firstChild&&previous.last===element.lastChild)return;
  const focused=document.activeElement;
  const selector=focused&&element.contains(focused)?focusSelector(focused):null;
  element.innerHTML=html;
  markup.set(element,{html,first:element.firstChild,last:element.lastChild});
  if(selector)element.querySelector(selector)?.focus({preventScroll:true});
}

// Keep stable card nodes through telemetry and reorder only changed positions.
export function updateKeyedList(element,entries){
  const previous=lists.get(element)||new Map(),next=new Map(),retained=new Set();
  const focused=document.activeElement;
  const focusKey=focused?[...previous].find(([,record])=>record.node.contains(focused))?.[0]:undefined;
  const selector=focusKey!==undefined?focusSelector(focused):null;
  const template=document.createElement('template');
  for(const entry of entries){
    const old=previous.get(entry.key);
    let node=old?.node;
    const replaced=node?.parentElement!==element||old.signature!==entry.signature;
    if(replaced){
      template.innerHTML=entry.html();
      node=template.content.firstElementChild;
      if(old?.node.parentElement===element)old.node.replaceWith(node);
    }
    if(replaced||old.value!==entry.value)entry.patch?.(node);
    next.set(entry.key,{node,signature:entry.signature,value:entry.value});
    retained.add(node);
  }
  for(const child of Array.from(element.children))if(!retained.has(child))child.remove();
  let cursor=element.firstElementChild;
  for(const {node} of next.values()){
    if(cursor===node)cursor=cursor.nextElementSibling;
    else element.insertBefore(node,cursor);
  }
  lists.set(element,next);
  if(focusKey!==undefined&&document.activeElement!==focused){
    if(focused.isConnected)focused.focus({preventScroll:true});
    else if(selector)next.get(focusKey)?.node.querySelector(selector)?.focus({preventScroll:true});
  }
}
