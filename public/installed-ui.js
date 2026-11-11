export function enableInstalledUI({onSearch}) {
  const connection = document.querySelector('#connection-form');
  for (const child of connection.children) {
    if (!child.classList.contains('dialog-heading')) child.hidden = true;
  }
  document.querySelector('#installed-connection').hidden = false;

  const shortcuts = document.querySelector('#installed-search-examples').content.cloneNode(true);
  for (const button of shortcuts.querySelectorAll('[data-starter-query]')) {
    button.addEventListener('click', () => onSearch(button.dataset.starterQuery));
  }
  document.querySelector('#search-form').after(shortcuts);
}
