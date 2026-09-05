for (const sample of document.querySelectorAll('[data-origin]')) {
  sample.textContent = sample.textContent.replaceAll('https://board.example', location.origin);
}
