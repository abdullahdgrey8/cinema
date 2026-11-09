export function createCompanionUI({request,onAdded}) {
  const get=id=>document.getElementById(id);
  const dialog=get('companion-magnet'),form=get('companion-magnet-form'),input=get('companion-magnet-input');
  const status=get('companion-magnet-status'),submit=form.querySelector('[type=submit]');
  const closeButtons=Array.from(form.querySelectorAll('[data-close]'));
  let enabled=false,busy=false,opener;

  function setBusy(value) {
    busy=value;
    form.setAttribute('aria-busy',String(value));
    input.readOnly=submit.disabled=value;
    for(const button of closeButtons)button.disabled=value;
  }

  function open(button) {
    if(!enabled||dialog.open)return;
    opener=button;
    status.textContent='';
    input.removeAttribute('aria-invalid');
    dialog.showModal();
    input.focus();
  }

  document.addEventListener('click',event=>{
    const button=event.target.closest('[data-companion-add]');
    if(button)open(button);
  });
  dialog.addEventListener('cancel',event=>{if(busy)event.preventDefault();});
  dialog.addEventListener('close',()=>{if(opener?.isConnected)opener.focus({preventScroll:true});});
  input.addEventListener('input',()=>{input.removeAttribute('aria-invalid');status.textContent='';});
  form.addEventListener('submit',async event=>{
    event.preventDefault();
    if(!enabled||busy)return;
    const magnet=input.value.trim();
    if(!/^magnet:\?/i.test(magnet)){
      status.textContent='Paste a BitTorrent magnet link.';
      input.setAttribute('aria-invalid','true');input.focus();return;
    }
    setBusy(true);status.textContent='Adding your download…';
    try{
      const operation=await request(magnet);
      input.value='';status.textContent='';
      dialog.close();onAdded(operation);
    }catch(error){
      status.textContent=error.message;
      if(error.status===400)input.setAttribute('aria-invalid','true');
      input.focus();
    }finally{setBusy(false);}
  });

  return {
    get enabled(){return enabled;},
    enable(){
      if(enabled)return;
      enabled=true;
      document.title='Cinema Scene Preview';
      get('companion-add').hidden=false;get('companion-intro').hidden=false;
      const connection=get('connection-form');
      for(const child of connection.children)if(!child.classList.contains('dialog-heading'))child.hidden=true;
      const info=document.createElement('p');info.className='muted';
      info.textContent='The Scene Preview shortcut manages this connection and uses a separate download folder.';
      connection.append(info);
    },
  };
}
