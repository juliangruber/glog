var pushover = require('pushover');
var markdown = require('github-flavored-markdown');
var git = require('git-file');
var through = require('through');
var JSONStream = require('JSONStream');
var split = require('split');
var qs = require('querystring');

var exec = require('child_process').exec;
var run = require('comandante');
var OrderedEmitter = require('ordered-emitter');

var fs = require('fs');
var path = require('path');

module.exports = function (repodir) {
    var glog = new Glog(repodir);
    var handle = glog.handle.bind(glog);
    
    Object.keys(Glog.prototype).forEach(function (key) {
        handle[key] = Glog.prototype[key].bind(glog);
    });
    return handle;
};

function Glog (repodir) {
    if (!(this instanceof Glog)) return new Glog(repodir);
    this.repo = pushover(repodir);
    this.repodir = repodir + '/blog.git';
}

var routes = {
    git : /^\/blog\.git\b/,
    json : /^\/blog\.json(?:\?(.*)|$)/,
    html : /^\/blog\/([^?]+\.html)(\?|$)/,
    markdown : /^\/blog\/([^?]+\.(?:md|markdown))(\?|$)/
};

Glog.prototype.handle = function (req, res) {
    var self = this;
    var m;
    
    if (routes.git.test(req.url)) {
        self.repo.handle(req, res);
    }
    else if (m = routes.json.exec(req.url)) {
        var params = qs.parse(m[1]);
        var ls = self.list();
        ls.on('error', function (err) {
            res.statusCode = 500;
            res.end(String(err));
        });
        
        res.setHeader('content-type', 'application/json');
        
        if (['html','markdown'].indexOf(params.inline) >= 0) {
            ls.pipe(self.inline(params.inline))
                .pipe(JSONStream.stringify())
                .pipe(res)
            ;
        }
        else {
            ls.pipe(JSONStream.stringify()).pipe(res);
        }
    }
    else if (m = routes.html.exec(req.url)) {
        var s = self.read(m[1].replace(/\.html$/, '.markdown'));
        
        var data = '';
        s.on('data', function (buf) { data += buf });
        s.on('end', function () {
            res.setHeader('content-type', 'text/html');
            res.end(markdown.parse(data));
        });
        
        s.on('error', function (err) {
            res.statusCode = 500;
            res.end(String(err));
        });
    }
    else if (m = routes.markdown.exec(req.url)) {
        var s = self.read(m[1]);
        res.setHeader('content-type', 'text/plain');
        s.pipe(res);
        
        s.on('error', function (err) {
            res.statusCode = 500;
            res.end(String(err));
        });
    }
    else {
        req.statusCode = 404;
        res.end('not found');
    }
};

Glog.prototype.test = function (url) {
    return Object.keys(routes).some(function (key) {
        return routes[key].test(url);
    });
};

Glog.prototype.read = function (file) {
    return git.read('HEAD', file, { cwd : this.repodir });
};

Glog.prototype.list = function () {
    var opts = { cwd : this.repodir };
    exec('git tag -l', opts, function (err, stdout, stderr) {
        if (err) return tr.emit('error', err);
        
        var args = [ 'show' ]
            .concat(stdout.split('\n'))
            .concat('--')
            .filter(Boolean)
        ;
        run('git', args, opts).pipe(split()).pipe(tr);
    });
    
    var tag = null;
    var tr = through(function (line) {
        var m;
        if (m = /^tag\s+(.+\.(?:markdown|md|html))/.exec(line)) {
            tag = { file : m[1] };
        }
        else if (!tag) return;
        
        if (tag.date && !tag.title && /\S/.test(line)) {
            tag.title = line;
        }
        else if (m = /^Tagger:\s+(.+)/.exec(line)) {
            var s = /(.+) <(.+?)>/.exec(m[1]);
            if (s) {
                tag.author = s[1];
                tag.email = s[2];
            }
            else tag.author = m[1]
        }
        else if (m = /^Date:\s+(.+)/.exec(line)) {
            tag.date = m[1];
        }
        else if (m = /^commit\s+(\S+)/.exec(line)) {
            tag.commit = m[1];
            this.emit('data', tag);
            tag = null;
        }
    });
    return tr;
};

Glog.prototype.inline = function (format) {
    var self = this;
    var em = new OrderedEmitter;
    em.on('data', function (doc) {
        tr.emit('data', doc.value);
        if (--pending === 0 && ended) {
            tr.emit('end');
        }
    });
    var order = 0;
    var pending = 0;
    var ended = false;
    
    var tr = through(write, end);
    return tr;
    
    function write (doc) {
        var s = self.read(doc.file);
        var n = order ++;
        pending ++;
        
        var data = '';
        s.on('data', function (buf) { data += buf });
        s.on('end', function () {
            doc.body = ({
                html : markdown.parse,
                markdown : String
            }[format] || String)(data);
            
            em.emit('data', { order : n, value : doc });
        });
    }
    
    function end () {
        ended = true;
        if (pending === 0) tr.emit('end');
    }
};
