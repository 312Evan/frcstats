var colors = ['#e61818', '#ff9f36', '#0ddfa9', '#2953d4', '#d429bd', "#8a12e6"];
var color1 = colors[Math.floor(Math.random() * colors.length)];
var color2 = colors[Math.floor(Math.random() * colors.length)];
document.querySelector('.header').style.background = `linear-gradient(to right, ${color1}, ${color2})`;