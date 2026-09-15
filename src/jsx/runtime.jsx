/*
 * after-effects-mcp runtime
 * Injected ahead of every script sent to After Effects.
 *
 * ExtendScript is ES3: no JSON, no Array.prototype.{indexOf,forEach,map},
 * no Object.keys, no String.prototype.trim. Everything below sticks to ES3.
 */

var AEMCP = (function () {
    var api = {};

    /* ---------------------------------------------------------------- JSON */

    /*
     * ExtendScript puts operator-overload hooks on Object.prototype, so a plain
     * object lookup like MAP['-'] / MAP['*'] / MAP['/'] returns a Function
     * instead of undefined. Every lookup keyed by untrusted data therefore goes
     * through own() -- and quote() avoids map lookups altogether.
     */
    function own(map, key) {
        return map.hasOwnProperty(key) ? map[key] : undefined;
    }
    api.own = own;

    function quote(s) {
        s = String(s);
        var out = '"';
        for (var i = 0; i < s.length; i++) {
            var code = s.charCodeAt(i);
            switch (code) {
                case 8:  out += '\\b'; break;
                case 9:  out += '\\t'; break;
                case 10: out += '\\n'; break;
                case 12: out += '\\f'; break;
                case 13: out += '\\r'; break;
                case 34: out += '\\"'; break;
                case 92: out += '\\\\'; break;
                default:
                    if (code < 0x20 || code > 0x7e) {
                        // Escape non-ASCII so the payload survives the trip to disk.
                        var hex = code.toString(16);
                        while (hex.length < 4) { hex = '0' + hex; }
                        out += '\\u' + hex;
                    } else {
                        out += s.charAt(i);
                    }
            }
        }
        return out + '"';
    }

    function stringify(value, depth) {
        depth = depth || 0;
        if (depth > 24) { return '"<max depth>"'; }

        if (value === null || value === undefined) { return 'null'; }

        var t = typeof value;
        if (t === 'boolean') { return value ? 'true' : 'false'; }
        if (t === 'number') { return isFinite(value) ? String(value) : 'null'; }
        if (t === 'string') { return quote(value); }

        if (value instanceof Array) {
            var items = [];
            for (var i = 0; i < value.length; i++) {
                items.push(stringify(value[i], depth + 1));
            }
            return '[' + items.join(',') + ']';
        }

        if (value instanceof Date) { return quote(value.toString()); }

        if (t === 'object') {
            var pairs = [];
            for (var k in value) {
                if (!value.hasOwnProperty(k)) { continue; }
                var v = value[k];
                if (typeof v === 'function' || v === undefined) { continue; }
                pairs.push(quote(k) + ':' + stringify(v, depth + 1));
            }
            return '{' + pairs.join(',') + '}';
        }

        return 'null';
    }
    api.stringify = stringify;

    /* -------------------------------------------------------------- basics */

    function trim(s) { return String(s).replace(/^\s+|\s+$/g, ''); }
    api.trim = trim;

    function lower(s) { return String(s).toLowerCase(); }

    function err(message) { throw new Error(message); }
    api.err = err;

    /* ------------------------------------------------------------ lookups  */

    // Accepts a comp name, a 1-based project item index, or a project item id.
    // `undefined`/null means "the active comp".
    api.comp = function (ref) {
        if (ref === undefined || ref === null || ref === '') {
            var active = app.project.activeItem;
            if (!active || !(active instanceof CompItem)) {
                err('No active composition. Open a comp in the timeline, or pass `comp` explicitly.');
            }
            return active;
        }

        if (typeof ref === 'number') {
            // Try item id first (ids are unique and usually > numItems), then index.
            var byId = api.itemById(ref, true);
            if (byId && byId instanceof CompItem) { return byId; }
            if (ref >= 1 && ref <= app.project.numItems) {
                var byIndex = app.project.item(ref);
                if (byIndex instanceof CompItem) { return byIndex; }
            }
            err('No composition with id or index ' + ref + '.');
        }

        var name = lower(trim(ref));
        var fallback = null;
        for (var i = 1; i <= app.project.numItems; i++) {
            var item = app.project.item(i);
            if (!(item instanceof CompItem)) { continue; }
            if (item.name === ref) { return item; }
            if (lower(item.name) === name && !fallback) { fallback = item; }
        }
        if (fallback) { return fallback; }
        err('No composition named "' + ref + '". Use ae_list_comps to see what exists.');
    };

    api.itemById = function (id, soft) {
        for (var i = 1; i <= app.project.numItems; i++) {
            if (app.project.item(i).id === id) { return app.project.item(i); }
        }
        if (soft) { return null; }
        err('No project item with id ' + id + '.');
    };

    // Accepts a layer name, a 1-based layer index, or a negative index from the end.
    api.layer = function (comp, ref) {
        if (ref === undefined || ref === null || ref === '') {
            var sel = comp.selectedLayers;
            if (sel.length === 0) { err('No layer specified and nothing is selected in "' + comp.name + '".'); }
            return sel[0];
        }

        if (typeof ref === 'number') {
            var idx = ref < 0 ? comp.numLayers + 1 + ref : ref;
            if (idx < 1 || idx > comp.numLayers) {
                err('Layer index ' + ref + ' is out of range (comp "' + comp.name + '" has ' + comp.numLayers + ' layers).');
            }
            return comp.layer(idx);
        }

        var name = lower(trim(ref));
        var fallback = null;
        for (var i = 1; i <= comp.numLayers; i++) {
            var l = comp.layer(i);
            if (l.name === ref) { return l; }
            if (lower(l.name) === name && !fallback) { fallback = l; }
        }
        if (fallback) { return fallback; }
        err('No layer named "' + ref + '" in comp "' + comp.name + '".');
    };

    api.layers = function (comp, refs) {
        var out = [];
        if (refs === undefined || refs === null) {
            var sel = comp.selectedLayers;
            for (var s = 0; s < sel.length; s++) { out.push(sel[s]); }
            if (out.length === 0) { err('No layers specified and nothing is selected in "' + comp.name + '".'); }
            return out;
        }
        if (!(refs instanceof Array)) { refs = [refs]; }
        for (var i = 0; i < refs.length; i++) { out.push(api.layer(comp, refs[i])); }
        return out;
    };

    /* ----------------------------------------------------- property lookup */

    function childProperty(group, token) {
        if (!group) { return null; }

        // Direct hit by name or matchName (fast path, also catches Transform
        // properties addressed straight off a layer).
        try {
            var direct = group.property(token);
            if (direct) { return direct; }
        } catch (e) { /* property() throws when the name is unknown */ }

        var count = 0;
        try { count = group.numProperties; } catch (e2) { return null; }

        var target = lower(trim(token));
        for (var i = 1; i <= count; i++) {
            var child;
            try { child = group.property(i); } catch (e3) { continue; }
            if (!child) { continue; }
            if (lower(child.name) === target) { return child; }
            try {
                if (child.matchName && lower(child.matchName) === target) { return child; }
            } catch (e4) { /* some properties have no matchName */ }
        }
        return null;
    }

    /*
     * Resolves "Transform.Position", "Effects.Gaussian Blur.Blurriness", or the
     * array form ["ADBE Effect Parade", "ADBE Gaussian Blur 2", "ADBE Gaussian Blur 2-0001"].
     *
     * Dot paths are greedy-joined on failure so effect names containing a dot
     * (e.g. "Levels.1") still resolve.
     */
    api.prop = function (root, path) {
        if (path === undefined || path === null || path === '') {
            err('No property path given.');
        }
        var parts = (path instanceof Array) ? path : String(path).split('.');

        var current = root;
        var i = 0;
        while (i < parts.length) {
            var found = null;
            var consumed = 0;

            // Prefer the longest token that resolves, so dotted names survive.
            for (var take = parts.length - i; take >= 1; take--) {
                var token = [];
                for (var t = 0; t < take; t++) { token.push(parts[i + t]); }
                var candidate = childProperty(current, token.join('.'));
                if (candidate) { found = candidate; consumed = take; break; }
            }

            if (!found) {
                var sofar = [];
                for (var s = 0; s <= i; s++) { sofar.push(parts[s]); }
                err('Property not found: "' + sofar.join('.') + '". Available here: ' +
                    api.childNames(current).join(', '));
            }
            current = found;
            i += consumed;
        }
        return current;
    };

    api.childNames = function (group) {
        var names = [];
        var count = 0;
        try { count = group.numProperties; } catch (e) { return ['<no sub-properties>']; }
        for (var i = 1; i <= count && i <= 60; i++) {
            try { names.push(group.property(i).name); } catch (e2) { /* skip */ }
        }
        if (count > 60) { names.push('... (' + count + ' total)'); }
        return names.length ? names : ['<none>'];
    };

    /* ------------------------------------------------------- serialisation */

    api.value = function (prop, time) {
        try {
            var v = (time === undefined || time === null) ? prop.value : prop.valueAtTime(time, false);
            return api.plain(v, prop.propertyValueType);
        } catch (e) {
            return null;
        }
    };

    api.plain = function (v, valueType) {
        if (v === null || v === undefined) { return null; }

        if (valueType === PropertyValueType.TEXT_DOCUMENT) {
            return api.textDocument(v);
        }
        if (valueType === PropertyValueType.SHAPE) { return '<shape>'; }
        if (valueType === PropertyValueType.MARKER) {
            return { comment: v.comment, chapter: v.chapter, duration: v.duration };
        }
        if (v instanceof Array) {
            var out = [];
            for (var i = 0; i < v.length; i++) { out.push(api.round(v[i])); }
            return out;
        }
        if (typeof v === 'number') { return api.round(v); }
        if (typeof v === 'boolean' || typeof v === 'string') { return v; }
        return String(v);
    };

    // Trims float noise (AE hands back things like 959.9999999999999).
    api.round = function (n) {
        if (typeof n !== 'number' || !isFinite(n)) { return n; }
        return Math.round(n * 1e6) / 1e6;
    };

    api.textDocument = function (doc) {
        var out = { text: doc.text };
        var fields = ['font', 'fontSize', 'fillColor', 'strokeColor', 'strokeWidth',
                      'tracking', 'leading', 'justification', 'applyFill', 'applyStroke'];
        for (var i = 0; i < fields.length; i++) {
            try {
                var value = doc[fields[i]];
                if (value !== undefined) { out[fields[i]] = api.plain(value); }
            } catch (e) { /* field unsupported on this AE version */ }
        }
        return out;
    };

    api.layerType = function (layer) {
        if (layer instanceof TextLayer) { return 'text'; }
        if (layer instanceof ShapeLayer) { return 'shape'; }
        if (layer instanceof CameraLayer) { return 'camera'; }
        if (layer instanceof LightLayer) { return 'light'; }
        if (layer instanceof AVLayer) {
            if (layer.nullLayer) { return 'null'; }
            if (layer.adjustmentLayer) { return 'adjustment'; }
            if (layer.source instanceof CompItem) { return 'precomp'; }
            if (layer.source instanceof SolidSource ||
                (layer.source && layer.source.mainSource instanceof SolidSource)) { return 'solid'; }
            return 'footage';
        }
        return 'unknown';
    };

    api.serializeLayer = function (layer, detail) {
        var out = {
            index: layer.index,
            name: layer.name,
            type: api.layerType(layer),
            enabled: layer.enabled,
            inPoint: api.round(layer.inPoint),
            outPoint: api.round(layer.outPoint),
            startTime: api.round(layer.startTime)
        };

        if (layer.locked) { out.locked = true; }
        if (layer.shy) { out.shy = true; }
        if (layer.solo) { out.solo = true; }
        if (layer.parent) { out.parent = { index: layer.parent.index, name: layer.parent.name }; }

        try { if (layer.threeDLayer) { out.threeD = true; } } catch (e) { /* not an AVLayer */ }
        try { if (layer.source) { out.source = { id: layer.source.id, name: layer.source.name }; } } catch (e2) {}

        if (detail === 'minimal') { return out; }

        out.transform = api.transform(layer);

        if (layer instanceof TextLayer) {
            try { out.text = api.textDocument(layer.property('Source Text').value); } catch (e3) {}
        }

        try {
            if (layer.blendingMode !== BlendingMode.NORMAL) {
                out.blendingMode = api.blendModeName(layer.blendingMode);
            }
        } catch (e4) {}

        var effects = api.effectList(layer);
        if (effects.length) { out.effects = effects; }

        var animated = api.animatedProperties(layer);
        if (animated.length) { out.animated = animated; }

        var masks = 0;
        try { masks = layer.property('ADBE Mask Parade').numProperties; } catch (e5) {}
        if (masks) { out.maskCount = masks; }

        return out;
    };

    api.transform = function (layer) {
        var out = {};
        var names = ['Anchor Point', 'Position', 'Scale', 'Rotation', 'Opacity',
                     'X Rotation', 'Y Rotation', 'Z Rotation', 'Orientation'];
        var group;
        try { group = layer.property('ADBE Transform Group'); } catch (e) { return out; }
        if (!group) { return out; }

        for (var i = 0; i < names.length; i++) {
            var p = null;
            try { p = group.property(names[i]); } catch (e2) { continue; }
            if (!p) { continue; }
            out[api.camel(names[i])] = api.value(p);
        }
        return out;
    };

    api.camel = function (name) {
        var parts = String(name).split(' ');
        var out = lower(parts[0]);
        for (var i = 1; i < parts.length; i++) {
            out += parts[i].charAt(0).toUpperCase() + lower(parts[i].substring(1));
        }
        return out;
    };

    api.effectList = function (layer) {
        var out = [];
        var parade;
        try { parade = layer.property('ADBE Effect Parade'); } catch (e) { return out; }
        if (!parade) { return out; }

        for (var i = 1; i <= parade.numProperties; i++) {
            var fx = parade.property(i);
            out.push({
                index: i,
                name: fx.name,
                matchName: fx.matchName,
                enabled: fx.enabled
            });
        }
        return out;
    };

    // Walks a layer for properties that carry keyframes or expressions, so the
    // caller can see what is actually animated without dumping the whole tree.
    api.animatedProperties = function (root, prefix, depth, acc) {
        acc = acc || [];
        depth = depth || 0;
        prefix = prefix || '';
        if (depth > 6 || acc.length >= 120) { return acc; }

        var count = 0;
        try { count = root.numProperties; } catch (e) { return acc; }

        for (var i = 1; i <= count; i++) {
            var p;
            try { p = root.property(i); } catch (e2) { continue; }
            if (!p) { continue; }

            var path = prefix ? prefix + '.' + p.name : p.name;

            if (p.propertyType === PropertyType.PROPERTY) {
                var entry = null;
                try {
                    if (p.numKeys > 0) {
                        entry = { path: path, keys: p.numKeys };
                        entry.firstKeyTime = api.round(p.keyTime(1));
                        entry.lastKeyTime = api.round(p.keyTime(p.numKeys));
                    }
                    if (p.expressionEnabled && trim(p.expression) !== '') {
                        entry = entry || { path: path };
                        entry.expression = p.expression;
                    }
                } catch (e3) { /* property does not support keys */ }
                if (entry) { acc.push(entry); }
            } else {
                api.animatedProperties(p, path, depth + 1, acc);
            }
        }
        return acc;
    };

    api.serializeComp = function (comp, detail) {
        var out = {
            id: comp.id,
            name: comp.name,
            width: comp.width,
            height: comp.height,
            frameRate: api.round(comp.frameRate),
            duration: api.round(comp.duration),
            durationFrames: Math.round(comp.duration * comp.frameRate),
            pixelAspect: api.round(comp.pixelAspect),
            bgColor: api.plain(comp.bgColor),
            numLayers: comp.numLayers,
            workArea: { start: api.round(comp.workAreaStart), duration: api.round(comp.workAreaDuration) }
        };
        if (detail === 'none') { return out; }

        out.layers = [];
        for (var i = 1; i <= comp.numLayers; i++) {
            out.layers.push(api.serializeLayer(comp.layer(i), detail));
        }
        return out;
    };

    api.serializeItem = function (item) {
        var out = { id: item.id, name: item.name, typeName: item.typeName };
        try { out.parentFolder = item.parentFolder ? item.parentFolder.name : null; } catch (e) {}

        if (item instanceof FolderItem) {
            out.kind = 'folder';
            out.numItems = item.numItems;
            return out;
        }
        if (item instanceof CompItem) {
            out.kind = 'comp';
            out.width = item.width;
            out.height = item.height;
            out.duration = api.round(item.duration);
            out.frameRate = api.round(item.frameRate);
            out.numLayers = item.numLayers;
            return out;
        }

        out.kind = 'footage';
        try { out.width = item.width; out.height = item.height; } catch (e2) {}
        try { out.duration = api.round(item.duration); } catch (e3) {}
        try {
            if (item.mainSource instanceof FileSource && item.mainSource.file) {
                out.file = item.mainSource.file.fsName;
            } else if (item.mainSource instanceof SolidSource) {
                out.kind = 'solid';
                out.color = api.plain(item.mainSource.color);
            } else if (item.mainSource instanceof PlaceholderSource) {
                out.kind = 'placeholder';
            }
        } catch (e4) {}
        return out;
    };

    /* ------------------------------------------------------------- enums   */

    var BLEND_NAMES = null;
    api.blendModeName = function (mode) {
        if (!BLEND_NAMES) {
            BLEND_NAMES = {};
            for (var k in BlendingMode) {
                if (BlendingMode.hasOwnProperty(k)) { BLEND_NAMES[BlendingMode[k]] = k; }
            }
        }
        return own(BLEND_NAMES, mode) || String(mode);
    };

    api.blendModeFrom = function (name) {
        var key = String(name).toUpperCase().replace(/[\s-]+/g, '_');
        var mode = own(BlendingMode, key);
        if (mode === undefined) {
            err('Unknown blending mode "' + name + '". Try ADD, SCREEN, MULTIPLY, OVERLAY or SOFT_LIGHT.');
        }
        return mode;
    };

    /* --------------------------------------------------------------- time  */

    // Accepts seconds (number) or a "123f"/"f123" frame string.
    api.time = function (comp, t, fallback) {
        if (t === undefined || t === null || t === '') {
            return fallback === undefined ? comp.time : fallback;
        }
        if (typeof t === 'number') { return t; }
        var s = trim(String(t));
        var m = s.match(/^f?(-?[0-9]+(?:\.[0-9]+)?)f?$/i);
        if (m && /f/i.test(s)) { return parseFloat(m[1]) / comp.frameRate; }
        return parseFloat(s);
    };

    /* ------------------------------------------------------------- colors  */

    // "#ff8800" | "ff8800" | [r,g,b] 0-1 | [r,g,b] 0-255 -> [r,g,b] 0-1
    api.color = function (c) {
        if (c === undefined || c === null) { return null; }
        if (c instanceof Array) {
            var max = 0;
            for (var i = 0; i < c.length; i++) { if (c[i] > max) { max = c[i]; } }
            var scale = max > 1.0001 ? 255 : 1;
            return [ (c[0] || 0) / scale, (c[1] || 0) / scale, (c[2] || 0) / scale ];
        }
        var hex = String(c).replace(/^#/, '');
        if (hex.length === 3) {
            hex = hex.charAt(0) + hex.charAt(0) + hex.charAt(1) + hex.charAt(1) + hex.charAt(2) + hex.charAt(2);
        }
        if (!/^[0-9a-f]{6}$/i.test(hex)) { err('Bad color "' + c + '". Use "#rrggbb" or [r,g,b].'); }
        return [
            parseInt(hex.substring(0, 2), 16) / 255,
            parseInt(hex.substring(2, 4), 16) / 255,
            parseInt(hex.substring(4, 6), 16) / 255
        ];
    };


    /* -------------------------------------------------------------- items  */

    api.findItemByName = function (name) {
        var target = lower(trim(name));
        var fallback = null;
        for (var i = 1; i <= app.project.numItems; i++) {
            var item = app.project.item(i);
            if (item.name === name) { return item; }
            if (lower(item.name) === target && !fallback) { fallback = item; }
        }
        if (fallback) { return fallback; }
        err('No project item named "' + name + '". Use ae_project_info to list them.');
    };

    /* ------------------------------------------------------------ rotation */

    // 2D layers expose "Rotation"; 3D layers expose "Z Rotation" instead.
    api.rotationProp = function (layer) {
        var transform = layer.property('ADBE Transform Group');
        var p = childProperty(transform, 'ADBE Rotate Z');
        if (p) { return p; }
        p = childProperty(transform, 'Rotation');
        if (p) { return p; }
        err('This layer has no rotation property.');
    };

    /* -------------------------------------------------------------- shapes */

    var SHAPES = {
        rectangle: { matchName: 'ADBE Vector Shape - Rect', size: 'ADBE Vector Rect Size' },
        ellipse:   { matchName: 'ADBE Vector Shape - Ellipse', size: 'ADBE Vector Ellipse Size' },
        star:      { matchName: 'ADBE Vector Shape - Star', size: null }
    };

    api.buildShape = function (layer, comp, opts) {
        var kind = opts.shape || 'rectangle';
        var spec = own(SHAPES, kind);
        if (!spec) { err('Unknown shape "' + kind + '". Use rectangle, ellipse or star.'); }

        var width = opts.width || Math.round(comp.width / 4);
        var height = opts.height || Math.round(comp.height / 4);

        var group = layer.property('ADBE Root Vectors Group').addProperty('ADBE Vector Group');
        group.name = kind.charAt(0).toUpperCase() + kind.substring(1);
        var contents = group.property('ADBE Vectors Group');

        var shape = contents.addProperty(spec.matchName);
        if (kind === 'star') {
            shape.property('ADBE Vector Star Outer Radius').setValue(Math.min(width, height) / 2);
            shape.property('ADBE Vector Star Inner Radius').setValue(Math.min(width, height) / 4);
            if (opts.points) { shape.property('ADBE Vector Star Points').setValue(opts.points); }
        } else {
            shape.property(spec.size).setValue([width, height]);
            if (kind === 'rectangle' && opts.cornerRadius) {
                shape.property('ADBE Vector Rect Roundness').setValue(opts.cornerRadius);
            }
        }

        var fill = contents.addProperty('ADBE Vector Graphic - Fill');
        fill.property('ADBE Vector Fill Color').setValue(api.color(opts.color || '#ffffff'));

        if (opts.strokeColor || opts.strokeWidth) {
            var stroke = contents.addProperty('ADBE Vector Graphic - Stroke');
            stroke.property('ADBE Vector Stroke Color').setValue(api.color(opts.strokeColor || '#000000'));
            stroke.property('ADBE Vector Stroke Width').setValue(opts.strokeWidth || 2);
        }

        // Shape layers are born with a zeroed anchor at the comp origin; centre them.
        var position = layer.property('ADBE Transform Group').property('ADBE Position');
        if (!opts.position) { position.setValue([comp.width / 2, comp.height / 2]); }

        return layer;
    };


    /* ----------------------------------------------------------- keyframes */

    function dimensions(prop) {
        var t = prop.propertyValueType;
        if (t === PropertyValueType.TwoD || t === PropertyValueType.TwoD_SPATIAL) { return 2; }
        if (t === PropertyValueType.ThreeD || t === PropertyValueType.ThreeD_SPATIAL) { return 3; }
        if (t === PropertyValueType.COLOR) { return 4; }
        return 1;
    }

    function isSpatial(prop) {
        var t = prop.propertyValueType;
        return t === PropertyValueType.TwoD_SPATIAL || t === PropertyValueType.ThreeD_SPATIAL;
    }

    var INTERP = {
        linear: KeyframeInterpolationType.LINEAR,
        bezier: KeyframeInterpolationType.BEZIER,
        hold: KeyframeInterpolationType.HOLD
    };

    function interpType(name, fallback) {
        if (!name) { return fallback; }
        var found = own(INTERP, lower(trim(name)));
        if (found === undefined) { err('Unknown interpolation "' + name + '". Use linear, bezier or hold.'); }
        return found;
    }

    function easeArray(prop, speed, influence) {
        // Spatial properties carry a single temporal ease; everything else needs
        // one per dimension.
        var count = isSpatial(prop) ? 1 : dimensions(prop);
        var eases = [];
        for (var i = 0; i < count; i++) { eases.push(new KeyframeEase(speed, influence)); }
        return eases;
    }

    /*
     * keys: [{ time, value, easing?, interpolation? }]
     * opts: { interpolation, easing, influence }
     *
     * easing is one of: none | in | out | both  (aka ease-in / ease-out on the
     * keyframe's own handles).
     */
    api.setKeys = function (prop, comp, keys, opts) {
        opts = opts || {};
        if (!prop.canVaryOverTime) {
            err('"' + prop.name + '" cannot be animated.');
        }

        var defaultInterp = interpType(opts.interpolation, KeyframeInterpolationType.BEZIER);
        var influence = opts.influence === undefined ? 33.33 : opts.influence;
        var defaultEasing = lower(opts.easing || 'both');

        var indices = [];
        for (var i = 0; i < keys.length; i++) {
            var time = api.time(comp, keys[i].time);
            var value = keys[i].value;
            if (prop.propertyValueType === PropertyValueType.COLOR && !(value instanceof Array)) {
                value = api.color(value);
                value.push(1);
            }
            prop.setValueAtTime(time, value);
            indices.push(prop.nearestKeyIndex(time));
        }

        for (var k = 0; k < indices.length; k++) {
            var index = indices[k];
            var spec = keys[k];
            var thisInterp = interpType(spec.interpolation, defaultInterp);
            var easing = lower(spec.easing || defaultEasing);

            var inType = thisInterp;
            var outType = thisInterp;
            if (thisInterp === KeyframeInterpolationType.HOLD) {
                outType = KeyframeInterpolationType.HOLD;
            }
            prop.setInterpolationTypeAtKey(index, inType, outType);

            if (thisInterp !== KeyframeInterpolationType.BEZIER || easing === 'none') { continue; }

            var flat = easeArray(prop, 0, influence);
            var neutral = easeArray(prop, 0, 0.1);
            var easeIn = (easing === 'in' || easing === 'both') ? flat : neutral;
            var easeOut = (easing === 'out' || easing === 'both') ? flat : neutral;
            prop.setTemporalEaseAtKey(index, easeIn, easeOut);
        }

        if (opts.spatialInterpolation && isSpatial(prop)) {
            var linear = lower(opts.spatialInterpolation) === 'linear';
            for (var s = 0; s < indices.length; s++) {
                prop.setSpatialAutoBezierAtKey(indices[s], !linear);
                if (linear) {
                    prop.setSpatialTangentsAtKey(indices[s], [0, 0, 0], [0, 0, 0]);
                }
            }
        }

        return indices;
    };

    api.serializeKeys = function (prop) {
        var keys = [];
        for (var i = 1; i <= prop.numKeys; i++) {
            keys.push({
                index: i,
                time: api.round(prop.keyTime(i)),
                value: api.plain(prop.keyValue(i), prop.propertyValueType)
            });
        }
        return keys;
    };


    /* ------------------------------------------------------------ effects  */

    // Accepts a display name ("Gaussian Blur") or a matchName, and returns the
    // matchName -- addProperty() is far more reliable with the latter.
    api.resolveEffect = function (nameOrMatch) {
        var wanted = lower(trim(nameOrMatch));
        var effects = app.effects;
        var fuzzy = null;

        for (var i = 0; i < effects.length; i++) {
            if (effects[i].matchName === nameOrMatch) { return effects[i].matchName; }
            if (lower(effects[i].displayName) === wanted) { return effects[i].matchName; }
            if (!fuzzy && lower(effects[i].displayName).indexOf(wanted) !== -1) { fuzzy = effects[i]; }
        }
        if (fuzzy) { return fuzzy.matchName; }
        err('No effect matching "' + nameOrMatch + '". Use ae_search_effects to find the right name.');
    };

    /* -------------------------------------------------------------- undo   */

    api.undoGroup = function (label, fn) {
        app.beginUndoGroup(label);
        try {
            return fn();
        } finally {
            app.endUndoGroup();
        }
    };

    return api;
})();
