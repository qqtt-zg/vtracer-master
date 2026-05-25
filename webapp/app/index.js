import init, { BinaryImageConverter, ColorImageConverter } from 'vtracer-webapp';

let runner;
const canvas = document.getElementById('frame');
const ctx = canvas.getContext('2d');
const svg = document.getElementById('svg');
const img = new Image();
const progress = document.getElementById('progressbar');
const progressregion = document.getElementById('progressregion');
let mode = 'spline', clustering_mode = 'color', clustering_hierarchical = 'stacked';
let wasmReady = false;
let pendingRestart = false;
let currentInputPath = '';
let desktopConvertDebounce = null;
let desktopRequestToken = 0;
let desktopExportDir = '';
let desktopStatusText = '';

let progressShowTime = 0;
let progressDisplayToken = 0;

function showProgress() {
    progressregion.style.display = 'block';
    progressShowTime = performance.now();
    return ++progressDisplayToken;
}

function hideProgress(token) {
    if (token !== progressDisplayToken) return;
    const elapsed = performance.now() - progressShowTime;
    const delay = Math.max(0, 1000 - elapsed);
    if (delay > 0) {
        setTimeout(() => {
            if (token === progressDisplayToken) {
                progressregion.style.display = 'none';
                progress.value = 0;
            }
        }, delay);
    } else {
        progressregion.style.display = 'none';
        progress.value = 0;
    }
}

const tauriApi = createTauriApi();
const isDesktopMode = tauriApi.isDesktop;

init()
    .then(() => {
        wasmReady = true;
        if (pendingRestart) {
            pendingRestart = false;
            restart();
        }
    })
    .catch((err) => {
        console.error('WASM init failed:', err);
    });

if (isDesktopMode) {
    initDesktopMode();
}

// Hide canas and svg on load
canvas.style.display = 'none';
svg.style.display = 'none';

// Paste from clipboard
document.addEventListener('paste', function (e) {
    if (e.clipboardData) {
        var items = e.clipboardData.items;
        if (!items) return;

        //access data directly
        for (var i = 0; i < items.length; i++) {
            if (items[i].type.indexOf("image") !== -1) {
                //image
                var blob = items[i].getAsFile();
                var URLObj = window.URL || window.webkitURL;
                var source = URLObj.createObjectURL(blob);
                setSourceAndRestart(source);
            }
        }
        e.preventDefault();
    }
});

// Download as SVG / desktop export
document.getElementById('export').addEventListener('click', async function (e) {
    if (isDesktopMode) {
        e.preventDefault();
        e.stopImmediatePropagation();
        await exportDesktopFile('svg');
        return;
    }

    const blob = new Blob([
        `<?xml version="1.0" encoding="UTF-8"?>\n`,
        `<!-- Generator: visioncortex VTracer -->\n`,
        new XMLSerializer().serializeToString(svg)
    ], {type: 'octet/stream'}),
    url = window.URL.createObjectURL(blob);

    this.href = url;
    this.target = '_blank';

    this.download = 'export-' + new Date().toISOString().slice(0, 19).replace(/:/g, '').replace('T', ' ') + '.svg';
});

// Store template config
var presetConfigs = [
    {
        src: 'assets/samples/K1_drawing.jpg',
        clustering_mode: 'binary',
        clustering_hierarchical: 'stacked',
        filter_speckle: 4,
        color_precision: 6,
        path_precision: 8,
        layer_difference: 16,
        mode: 'spline',
        corner_threshold: 60,
        length_threshold: 4,
        splice_threshold: 45,
        source: 'https://commons.wikimedia.org/wiki/File:K1_drawing.jpg',
        credit: '<a href="https://commons.wikimedia.org/">Wikimedia</a>',
    },
    {
        src: 'assets/samples/Cityscape_Sunset_DFM3-01.jpg',
        clustering_mode: 'color',
        clustering_hierarchical: 'stacked',
        filter_speckle: 4,
        color_precision: 8,
        path_precision: 8,
        layer_difference: 25,
        mode: 'spline',
        corner_threshold: 60,
        length_threshold: 4,
        splice_threshold: 45,
        source: 'https://www.vecteezy.com/vector-art/227400-beautiful-cityscape-at-sunset',
        credit: '<a href="https://www.vecteezy.com/free-vector/building">Building Vectors by Vecteezy</a>',
    },
    {
        src: 'assets/samples/Gum_Tree_Vector.jpg',
        clustering_mode: 'color',
        clustering_hierarchical: 'stacked',
        filter_speckle: 4,
        color_precision: 8,
        path_precision: 8,
        layer_difference: 28,
        mode: 'spline',
        corner_threshold: 60,
        length_threshold: 4,
        splice_threshold: 45,
        source: 'https://www.vecteezy.com/vector-art/172177-gum-tree-vector',
        credit: '<a href="https://www.vecteezy.com/free-vector/nature">Nature Vectors by Vecteezy</a>',
    },
    {
        src: 'assets/samples/vectorstock_31191940.png',
        clustering_mode: 'color',
        clustering_hierarchical: 'stacked',
        filter_speckle: 8,
        color_precision: 7,
        path_precision: 8,
        layer_difference: 64,
        mode: 'spline',
        corner_threshold: 60,
        length_threshold: 4,
        splice_threshold: 45,
        source: 'https://www.vectorstock.com/royalty-free-vector/dessert-poster-design-with-chocolate-cake-mousses-vector-31191940',
        credit: '<a href="https://www.vectorstock.com/royalty-free-vector/dessert-poster-design-with-chocolate-cake-mousses-vector-31191940">Vector image by VectorStock / vectorstock</a>',
    },
    {
        src: 'assets/samples/angel-luciano-LATYeZyw88c-unsplash-s.jpg',
        clustering_mode: 'color',
        clustering_hierarchical: 'stacked',
        filter_speckle: 10,
        color_precision: 8,
        path_precision: 8,
        layer_difference: 48,
        mode: 'spline',
        corner_threshold: 180,
        length_threshold: 4,
        splice_threshold: 45,
        source: 'https://unsplash.com/photos/LATYeZyw88c',
        credit: '<span>Photo by <a href="https://unsplash.com/@roaming_angel?utm_source=unsplash&amp;utm_medium=referral&amp;utm_content=creditCopyText">Angel Luciano</a> on <a href="https://unsplash.com/s/photos/dog?utm_source=unsplash&amp;utm_medium=referral&amp;utm_content=creditCopyText">Unsplash</a></span>',
    },
    {
        src: 'assets/samples/tank-unit-preview.png',
        clustering_mode: 'color',
        clustering_hierarchical: 'stacked',
        filter_speckle: 0,
        color_precision: 8,
        path_precision: 8,
        layer_difference: 0,
        mode: 'none',
        corner_threshold: 180,
        length_threshold: 4,
        splice_threshold: 45,
        source: 'https://opengameart.org/content/sideview-sci-fi-patreon-collection',
        credit: '<span>Artwork by <a href="https://opengameart.org/content/sideview-sci-fi-patreon-collection">Luis Zuno</a> on <a href="https://opengameart.org/">opengameart.org</a></span>',
    },
];

// Insert gallery items dynamically
if (document.getElementById('galleryslider')) {
    for (let i = 0; i < presetConfigs.length; i++) {
        document.getElementById('galleryslider').innerHTML += 
        `<li>
        <div class="galleryitem uk-panel uk-flex uk-flex-center">
            <a href="#">
                <img src="${presetConfigs[i].src}" title="${presetConfigs[i].source}">
            </a>
        </div>
        </li>`;
        document.getElementById('credits-modal-content').innerHTML += 
        `<p>${presetConfigs[i].credit}</p>`;
    }
}

// Function to load a given config WITHOUT restarting
function loadConfig(config) {
    mode = config.mode;
    clustering_mode = config.clustering_mode;
    clustering_hierarchical = config.clustering_hierarchical;

    globalcorner = config.corner_threshold;
    document.getElementById('cornervalue').innerHTML = globalcorner;
    document.getElementById('corner').value = globalcorner;
    
    globallength = config.length_threshold;
    document.getElementById('lengthvalue').innerHTML = globallength;
    document.getElementById('length').value = globallength;
    
    globalsplice = config.splice_threshold;
    document.getElementById('splicevalue').innerHTML = globalsplice;
    document.getElementById('splice').value = globalsplice;

    globalfilterspeckle = config.filter_speckle;
    document.getElementById('filterspecklevalue').innerHTML = globalfilterspeckle;
    document.getElementById('filterspeckle').value = globalfilterspeckle;

    globalcolorprecision = config.color_precision;
    document.getElementById('colorprecisionvalue').innerHTML = globalcolorprecision;
    document.getElementById('colorprecision').value = globalcolorprecision;

    globallayerdifference = config.layer_difference;
    document.getElementById('layerdifferencevalue').innerHTML = globallayerdifference;
    document.getElementById('layerdifference').value = globallayerdifference;

    globalpathprecision = config.path_precision;
    document.getElementById('pathprecisionvalue').innerHTML = globalpathprecision;
    document.getElementById('pathprecision').value = globalpathprecision;
}

// Choose template from gallery
let chooseGalleryButtons = document.querySelectorAll('.galleryitem a');
chooseGalleryButtons.forEach(item => {
    item.addEventListener('click', function (e) {
        // Load preset template config
        let i = Array.prototype.indexOf.call(chooseGalleryButtons, item);
        if (presetConfigs.length > i) {
            loadConfig(presetConfigs[i]);
        }

        // Set source as specified
        setSourceAndRestart(this.firstElementChild.src);
    });
});

// Upload button
var imageSelect = document.getElementById('imageSelect'),
imageInput = document.getElementById('imageInput');  
imageSelect.addEventListener('click', async function (e) {
    e.preventDefault();
    if (isDesktopMode) {
        await pickDesktopImage();
        return;
    }
    imageInput.click();
});

imageInput.addEventListener('change', function (e) {
    const file = this.files[0];
    const desktopPath = file && file.path ? file.path : '';
    setSourceAndRestart(file, desktopPath);
});

// Drag-n-Drop
var drop = document.getElementById('drop');
var droptext = document.getElementById('droptext');
drop.addEventListener('dragenter', function (e) {
    if (e.preventDefault) e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    droptext.classList.add('hovering');
    return false;
});

drop.addEventListener('dragleave', function (e) {
    if (e.preventDefault) e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    droptext.classList.remove('hovering');
    return false;
});

drop.addEventListener('dragover', function (e) {
    if (e.preventDefault) e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    droptext.classList.add('hovering');
    return false;
});

drop.addEventListener('drop', function (e) {
    if (e.preventDefault) e.preventDefault();
    droptext.classList.remove('hovering');
    const file = e.dataTransfer.files[0];
    const desktopPath = file && file.path ? file.path : '';
    setSourceAndRestart(file, desktopPath);
    return false;
});

// Get Input from UI controls
var globalcorner = parseInt(document.getElementById('corner').value),
    globallength = parseFloat(document.getElementById('length').value),
    globalsplice = parseInt(document.getElementById('splice').value),
    globalfilterspeckle = parseInt(document.getElementById('filterspeckle').value),
    globalcolorprecision = parseInt(document.getElementById('colorprecision').value),
    globallayerdifference = parseInt(document.getElementById('layerdifference').value),
    globalpathprecision = parseInt(document.getElementById('pathprecision').value);

// Load past inputs from localStorage
/*
if (localStorage.VSsettings) {
    var settings = JSON.parse(localStorage.VSsettings);
    document.getElementById('cornervalue').innerHTML = document.getElementById('corner').value = globalcorner = settings.globalcorner;
    document.getElementById('lengthvalue').innerHTML = document.getElementById('length').value = globallength = settings.globallength;
    document.getElementById('splicevalue').innerHTML = document.getElementById('splice').value = globalsplice = settings.globalsplice;
}
*/

document.getElementById('none').addEventListener('click', function (e) {
    mode = 'none';
    restart();
}, false);

document.getElementById('polygon').addEventListener('click', function (e) {
    mode = 'polygon';
    restart();
}, false);

document.getElementById('spline').addEventListener('click', function (e) {
    mode = 'spline';
    restart();
}, false);

document.getElementById('clustering-binary').addEventListener('click', function (e) {
    clustering_mode = 'binary';
    restart();
}, false);

document.getElementById('clustering-color').addEventListener('click', function (e) {
    clustering_mode = 'color';
    restart();
}, false);

document.getElementById('clustering-cutout').addEventListener('click', function (e) {
    clustering_hierarchical = 'cutout';
    restart();
}, false);

document.getElementById('clustering-stacked').addEventListener('click', function (e) {
    clustering_hierarchical = 'stacked';
    restart();
}, false);

document.getElementById('filterspeckle').addEventListener('change', function (e) {
    globalfilterspeckle = parseInt(this.value);
    document.getElementById('filterspecklevalue').innerHTML = this.value;
    restart();
});

document.getElementById('colorprecision').addEventListener('change', function (e) {
    globalcolorprecision = parseInt(this.value);
    document.getElementById('colorprecisionvalue').innerHTML = this.value;
    restart();
});

document.getElementById('layerdifference').addEventListener('change', function (e) {
    globallayerdifference = parseInt(this.value);
    document.getElementById('layerdifferencevalue').innerHTML = this.value;
    restart();
});

document.getElementById('corner').addEventListener('change', function (e) {
    globalcorner = parseInt(this.value);
    document.getElementById('cornervalue').innerHTML = this.value;
    restart();
});

document.getElementById('length').addEventListener('change', function (e) {
    globallength = parseFloat(this.value);
    document.getElementById('lengthvalue').innerHTML = this.value;
    restart();
});

document.getElementById('splice').addEventListener('change', function (e) {
    globalsplice = parseInt(this.value);
    document.getElementById('splicevalue').innerHTML = this.value;
    restart();
});

document.getElementById('pathprecision').addEventListener('change', function (e) {
    globalpathprecision = parseInt(this.value);
    document.getElementById('pathprecisionvalue').innerHTML = this.value;
    restart();
});

// Save inputs before unloading
/*
window.addEventListener('beforeunload', function () {
    localStorage.VSsettings = JSON.stringify({
        globalcorner: globalcorner,
        globallength: globallength,
        globalsplice: globalsplice,
    });
});
*/

function setSourceAndRestart(source, desktopPath = '') {
    if (desktopPath && typeof desktopPath === 'string') {
        currentInputPath = desktopPath;
    } else if (source instanceof File && source.path) {
        currentInputPath = source.path;
    } else {
        currentInputPath = '';
    }

    if (typeof source === 'string' && desktopPath) {
        currentInputPath = desktopPath;
    }

    img.src = source instanceof File ? URL.createObjectURL(source) : source;
    img.onload = function () {
        const width = img.naturalWidth, height = img.naturalHeight;
        svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        if (height > width) {
            document.getElementById('canvas-container').style.width = '50%';
            document.getElementById('canvas-container').style.marginBottom = (height / width * 50) + '%';
        } else {
            document.getElementById('canvas-container').style.width = '';
            document.getElementById('canvas-container').style.marginBottom = (height / width * 100) + '%';
        }
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        ctx.getImageData(0, 0, canvas.width, canvas.height);
        restart();
    }
    // Show display
    canvas.style.display = 'block';
    svg.style.display = 'block';
    // Hide upload text
    droptext.style.display = 'none';
}

function restart() {
    if (desktopConvertDebounce) {
        clearTimeout(desktopConvertDebounce);
        desktopConvertDebounce = null;
    }
    desktopRequestToken++;

    if (!wasmReady) {
        pendingRestart = true;
        return;
    }

    document.getElementById('clustering-binary').classList.remove('selected');
    document.getElementById('clustering-color').classList.remove('selected');
    document.getElementById('clustering-' + clustering_mode).classList.add('selected');
    Array.from(document.getElementsByClassName('clustering-color-options')).forEach((el) => {
        el.style.display = clustering_mode == 'color' ? '' : 'none';
    });

    document.getElementById('clustering-cutout').classList.remove('selected');
    document.getElementById('clustering-stacked').classList.remove('selected');
    document.getElementById('clustering-' + clustering_hierarchical).classList.add('selected');

    document.getElementById('none').classList.remove('selected');
    document.getElementById('polygon').classList.remove('selected');
    document.getElementById('spline').classList.remove('selected');
    document.getElementById(mode).classList.add('selected');
    Array.from(document.getElementsByClassName('spline-options')).forEach((el) => {
        el.style.display = mode == 'spline' ? '' : 'none';
    });

    if (!img.src) {
        return;
    }

    if (isDesktopMode && currentInputPath) {
        if (runner) {
            runner.stop();
            runner = null;
        }
        scheduleDesktopRealtimeConvert();
        return;
    }

    while (svg.firstChild) {
        svg.removeChild(svg.firstChild);
    }
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0);
    let converter_params = JSON.stringify({
        'canvas_id': canvas.id,
        'svg_id': svg.id,
        'mode': mode,
        'clustering_mode': clustering_mode,
        'hierarchical': clustering_hierarchical,
        'corner_threshold': deg2rad(globalcorner),
        'length_threshold': globallength,
        'max_iterations': 10,
        'splice_threshold': deg2rad(globalsplice),
        'filter_speckle': globalfilterspeckle*globalfilterspeckle,
        'color_precision': 8-globalcolorprecision,
        'layer_difference': globallayerdifference,
        'path_precision': globalpathprecision,
    });
    if (runner) {
        runner.stop();
    }
    runner = new ConverterRunner(converter_params);
    progress.value = 0;
    runner.progressToken = showProgress();
    runner.run();
}

function deg2rad(deg) {
    return deg/180*3.141592654;
}

class ConverterRunner {
    constructor (converter_params) {
        this.converter =
            clustering_mode == 'color' ?
                ColorImageConverter.new_with_string(converter_params):
                BinaryImageConverter.new_with_string(converter_params);
        this.converter.init();
        this.stopped = false;
        if (clustering_mode == 'binary') {
            svg.style.background = '#fff';
            canvas.style.display = 'none';
        } else {
            svg.style.background = '';
            canvas.style.display = '';
        }
        canvas.style.opacity = '';
    }

    run () {
        const This = this;
        setTimeout(function tick () {
            if (!This.stopped) {
                let done = false;
                const startTick = performance.now();
                while (!(done = This.converter.tick()) &&
                    performance.now() - startTick < 25) {
                }
                progress.value = This.converter.progress();
                if (progress.value >= 50) {
                    canvas.style.display = 'none';
                } else {
                    canvas.style.opacity = (50 - progress.value) / 25;
                }
                if (progress.value >= progress.max) {
                    hideProgress(This.progressToken);
                }
                if (!done) {
                    setTimeout(tick, 1);
                }
            }
        }, 1);
    }

    stop () {
        this.stopped = true;
        this.converter.free();
    }
}

document.getElementById('exportPdf').addEventListener('click', async function (e) {
    if (!isDesktopMode) {
        return;
    }
    e.preventDefault();
    e.stopImmediatePropagation();
    await exportDesktopFile('pdf');
}, true);

function createTauriApi() {
    const tauriGlobal = window.__TAURI__ || {};
    const core = tauriGlobal.core || {};
    const windowApi = tauriGlobal.window || {};
    const internals = window.__TAURI_INTERNALS__ || {};

    const invoke = core.invoke || internals.invoke;
    const convertFileSrc = core.convertFileSrc || internals.convertFileSrc;
    const getCurrentWindow = windowApi.getCurrentWindow;
    return {
        isDesktop: typeof invoke === 'function',
        invoke: invoke,
        convertFileSrc: convertFileSrc,
        getCurrentWindow: typeof getCurrentWindow === 'function' ? getCurrentWindow : null,
    };
}

async function initDesktopMode() {
    document.body.classList.add('desktop-window-mode');
    try {
        const result = await tauriApi.invoke('get_export_dir');
        desktopExportDir = result.path || '';
    } catch (err) {
        console.error('failed to load export dir', err);
    }
    installDesktopControls();
    installWindowControls();
    registerDesktopE2EHelpers();
}

function installDesktopControls() {
    const actionContainer = document.querySelector('.topbar-actions');
    if (!actionContainer) {
        return;
    }
    const button = document.createElement('button');
    button.className = 'btn btn-primary';
    button.textContent = '导出目录';
    button.addEventListener('click', async function () {
        try {
            await tauriApi.invoke('pick_export_dir');
        } catch (err) {
            if (isDesktopCancelled(err)) {
                return;
            }
            const text = parseDesktopError(err, '选择导出目录失败');
            window.alert(text);
        }
    });

    const windowControls = document.getElementById('desktopWindowControls');
    if (windowControls) {
        actionContainer.insertBefore(button, windowControls);
    } else {
        actionContainer.appendChild(button);
    }
}

function updateDesktopStatus() {
    // 隐藏状态文本，不再使用
}

function setDesktopStatus(text) {
    desktopStatusText = text || '';
    updateDesktopStatus();
}

async function pickDesktopImage() {
    try {
        const info = await tauriApi.invoke('pick_input_image');
        if (!info || !info.path) {
            return;
        }
        const source = desktopPathToSrc(info.path);
        setSourceAndRestart(source, info.path);
        setDesktopStatus(`已加载: ${info.path.split(/[\\\\/]/).pop()}`);
    } catch (err) {
        if (isDesktopCancelled(err)) {
            return;
        }
        const text = parseDesktopError(err, '选择图片失败');
        window.alert(text);
    }
}

function scheduleDesktopRealtimeConvert() {
    if (!currentInputPath) {
        return;
    }
    if (desktopConvertDebounce) {
        clearTimeout(desktopConvertDebounce);
    }
    const requestToken = ++desktopRequestToken;
    const pToken = showProgress();
    progress.value = 15;
    setDesktopStatus('转换中');

    desktopConvertDebounce = setTimeout(async function () {
        try {
            try {
                const cancelResult = await tauriApi.invoke('cancel_active_convert');
                if (cancelResult && cancelResult.ok) {
                    setDesktopStatus('已取消旧任务');
                }
            } catch (cancelErr) {
                console.warn('cancel_active_convert failed', cancelErr);
            }
            const request = buildDesktopRequest();
            const result = await tauriApi.invoke('convert_realtime', { request: request });
            if (requestToken !== desktopRequestToken) {
                return;
            }
            renderSvgText(result.svg_text);
            progress.value = 100;
            setDesktopStatus(`转换完成 ${result.meta && result.meta.duration_ms ? result.meta.duration_ms : 0}ms`);
        } catch (err) {
            if (requestToken !== desktopRequestToken) {
                return;
            }
            if (isDesktopCancelled(err)) {
                setDesktopStatus('已取消旧任务');
                return;
            }
            const text = parseDesktopError(err, '实时转换失败');
            setDesktopStatus(text);
            console.error(text);
        } finally {
            if (requestToken === desktopRequestToken) {
                hideProgress(pToken);
            }
        }
    }, 300);
}

function renderSvgText(svgText) {
    if (!svgText) {
        return;
    }
    const parser = new DOMParser();
    const parsed = parser.parseFromString(svgText, 'image/svg+xml');
    const root = parsed.documentElement;
    if (!root || root.nodeName.toLowerCase() !== 'svg') {
        return;
    }

    const viewBox = root.getAttribute('viewBox');
    if (viewBox) {
        svg.setAttribute('viewBox', viewBox);
    }
    svg.innerHTML = root.innerHTML;
    canvas.style.display = 'none';
    canvas.style.opacity = 0;
}

function buildDesktopRequest() {
    return {
        input_path: currentInputPath,
        params: {
            mode: mode,
            clustering_mode: clustering_mode,
            hierarchical: clustering_hierarchical,
            filter_speckle: globalfilterspeckle,
            color_precision: globalcolorprecision,
            layer_difference: globallayerdifference,
            corner_threshold: globalcorner,
            length_threshold: globallength,
            max_iterations: 10,
            splice_threshold: globalsplice,
            path_precision: globalpathprecision,
        },
    };
}

async function exportDesktopFile(format) {
    if (!img.src) {
        window.alert('请先选择或加载一张图片');
        return;
    }
    const request = buildDesktopRequest();
    request.svg_text = new XMLSerializer().serializeToString(svg);

    const pToken = showProgress();
    progress.value = 0;
    setDesktopStatus(`${format.toUpperCase()} 导出中...`);

    let simulatedProgress = 0;
    const interval = setInterval(() => {
        if (progressDisplayToken === pToken) {
            simulatedProgress += (100 - simulatedProgress) * 0.15;
            progress.value = simulatedProgress;
        }
    }, 50);

    try {
        const command = format === 'pdf' ? 'export_pdf' : 'export_svg';
        const result = await tauriApi.invoke(command, { request: request });
        const outPath = result && result.out_path ? result.out_path : '';
        setDesktopStatus(`${format.toUpperCase()} 导出成功`);
        console.info(`${format.toUpperCase()} exported: ${outPath}`);
        if (progressDisplayToken === pToken) progress.value = 100;
    } catch (err) {
        const text = parseDesktopError(err, `${format.toUpperCase()} 导出失败`);
        setDesktopStatus(text);
        window.alert(text);
    } finally {
        clearInterval(interval);
        hideProgress(pToken);
    }
}

function installWindowControls() {
    const controls = document.getElementById('desktopWindowControls');
    const dragRegion = document.getElementById('titlebarDragRegion');
    if (!controls || !dragRegion) {
        return;
    }

    const minBtn = document.getElementById('windowMinBtn');
    const maxBtn = document.getElementById('windowMaxBtn');
    const closeBtn = document.getElementById('windowCloseBtn');

    if (minBtn) {
        minBtn.addEventListener('click', () => tauriApi.invoke('minimize_window'));
    }
    if (maxBtn) {
        maxBtn.addEventListener('click', () => tauriApi.invoke('maximize_window'));
    }
    if (closeBtn) {
        closeBtn.addEventListener('click', () => tauriApi.invoke('close_window'));
    }

    dragRegion.addEventListener('dblclick', () => tauriApi.invoke('maximize_window'));

    dragRegion.addEventListener('mousedown', (e) => {
        if (e.target.closest('button, a, input, [data-tauri-drag-region="false"]')) {
            return;
        }
        if (e.buttons === 1) {
            tauriApi.invoke('drag_window').catch(() => {});
        }
    });
}



async function openDesktopImageByPath(path) {
    const info = await tauriApi.invoke('test_open_image', { path: path });
    const source = desktopPathToSrc(info.path);
    setSourceAndRestart(source, info.path);
    return info;
}

function registerDesktopE2EHelpers() {
    if (!isDesktopMode) {
        return;
    }
    window.__VTRACER_E2E = {
        openImageByPath: async (path) => openDesktopImageByPath(path),
        getLastExportPath: async () => tauriApi.invoke('test_get_last_export_path'),
        cancelActiveConvert: async () => tauriApi.invoke('cancel_active_convert'),
        getStatusText: () => desktopStatusText,
    };
}

function desktopPathToSrc(path) {
    if (tauriApi.convertFileSrc) {
        return tauriApi.convertFileSrc(path);
    }
    const normalized = path.replace(/\\/g, '/');
    return encodeURI(`file:///${normalized}`);
}

function parseDesktopError(err, fallback) {
    if (err && typeof err === 'object') {
        const code = err.code ? `[${err.code}] ` : '';
        const message = err.message || fallback;
        return `${code}${message}`;
    }
    if (typeof err === 'string') {
        return err;
    }
    return fallback;
}

function isDesktopCancelled(err) {
    if (err && typeof err === 'object' && err.code === 'CANCELLED') {
        return true;
    }
    if (typeof err === 'string' && err.includes('CANCELLED')) {
        return true;
    }
    return false;
}


