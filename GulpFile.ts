import * as gulp from 'gulp';
import * as templateCache from 'gulp-angular-templatecache';
import * as concat from 'gulp-concat';
import * as babel from 'gulp-babel';
import * as uglify from 'gulp-uglify';
import * as rename from 'gulp-rename';
import * as copy from 'gulp-copy';
import * as htmlmin from 'gulp-htmlmin';
import { getFilesFrom, replaceScripts, replaceStyles, run, task } from './ts-scripts/utils';
import { relative } from 'path';
import { copy as fsCopy, outputFile, readFile, readJSON, readJSONSync } from 'fs-extra';
import { IConfItem, IMetaJSON, IPackageJSON } from './ts-scripts/interface';

const zip = require('gulp-zip');
const s3 = require('gulp-s3');

const meta: IMetaJSON = readJSONSync('ts-scripts/meta.json');
const pack: IPackageJSON = readJSONSync('package.json');
const configurations = Object.keys(meta.configurations);
const AWS = {
    key: process.env.AWS_ACCESS_KEY_ID,
    secret: process.env.AWS_SECRET_ACCESS_KEY,
    region: 'eu-central-1'
};

const sourceFiles = getFilesFrom('./src/js', '.js', function (name, path) {
    return !name.includes('.spec') && !path.includes('/test/');
});


function moveTo(path: string): (relativePath: string) => string {
    return function (relativePath: string): string {
        return relative(path, relativePath);
    }
}

function getConfigFile(name: string, config: IConfItem): string {
    return `var WAVES_NETWORK_CONF = ${JSON.stringify({
        name,
        code: config.code,
        version: pack.version,
        server: config.server,
        matcher: config.matcher,
        datafeed: config.datafeed
    })};
    `;
}

task('up-version-json', function (done) {
    console.log('new version: ', pack.version);

    const promises = [
        './bower.json',
        './src/desktop/package.json'
    ].map((path) => {
        return readJSON(path).then((json) => {
            json.version = pack.version;
            return outputFile(path, JSON.stringify(json, null, 2));
        });
    });

    Promise.all(promises)
        .then(() => {
            return run('git', ['add', '.']);
        })
        .then(() => {
            return run('git', ['commit', '-m', `Message: "${pack.version}" for other json files`]);
        })
        .then(() => {
            done();
        });
});

task('templates', function () {
    return gulp.src('src/templates/**/*.html')
        .pipe(htmlmin({ collapseWhitespace: true }))
        .pipe(templateCache({
            module: 'app',
            transformUrl: function (url) {
                return url.replace('.html', '');
            }
        }))
        .pipe(gulp.dest('dist/dev/js'));
});

configurations.forEach((name) => {
    const config = meta.configurations[name];
    const jsName = `${pack.name}-${name}-${pack.version}.js`;
    const indexPromise = readFile('src/index.html', { encoding: 'utf8' });

    task(`concat-${name}`, ['uglify', 'templates'], function (done) {
        const stream = gulp.src(['dist/dev/js/vendors.js', 'dist/dev/js/bundle.min.js', 'dist/dev/js/templates.js'])
            .pipe(concat(jsName))
            .pipe(gulp.dest(`dist/${name}/js`));

        stream.on('end', function () {
            readFile(`dist/${name}/js/${jsName}`, { encoding: 'utf8' }).then((file) => {

                file = getConfigFile(name, config) + file;

                outputFile(`dist/${name}/js/${jsName}`, file)
                    .then(() => done());
            });
        });
    });

    task(`html-${name}`, [`concat-${name}`], function (done) {
        indexPromise.then((file) => {
            const filter = moveTo(`./dist/${name}`);

            file = replaceStyles(file, [`dist/${name}/css/${pack.name}-styles-${pack.version}.css`].map(filter));
            file = replaceScripts(file, [`dist/${name}/js/${jsName}`].map(filter));

            outputFile(`./dist/${name}/index.html`, file).then(() => done());
        });
    });

    task(`copy-${name}`, ['concat-style'], function (done) {
        let forCopy = [];

        if (name.includes('chrome')) {
            forCopy = [
                fsCopy('src/chrome', `dist/${name}`)
            ];
        } else if (name.includes('desktop')) {
            forCopy = [
                fsCopy('src/desktop', `dist/${name}`)
            ];
        } else {
            forCopy = [];
        }

        Promise.all([
            fsCopy(`dist/${pack.name}-styles-${pack.version}.css`, `dist/${name}/css/${pack.name}-styles-${pack.version}.css`),
            fsCopy('src/fonts', `dist/${name}/fonts`),
            fsCopy('LICENSE', `dist/${name}/LICENSE`),
            fsCopy('3RD-PARTY-LICENSES.txt', `dist/${name}/3RD-PARTY-LICENSES.txt`),
            fsCopy('src/img', `dist/${name}/img`)
        ].concat(forCopy)).then(() => {
            done();
        }, (e) => {
            console.log(e.message);
        });
    });

    task(`zip-${name}`, [
        `concat-${name}`,
        `html-${name}`,
        `copy-${name}`
    ], function () {
        return gulp.src(`dist/${name}/**/*.*`)
            .pipe(zip(`${pack.name}-${name}-v${pack.version}.zip`))
            .pipe(gulp.dest('dist'));
    })

});

task('concat-style', ['less'], function () {
    const target = `${pack.name}-styles-${pack.version}.css`;
    return gulp.src(meta.stylesheets)
        .pipe(concat(target))
        .pipe(gulp.dest('dist/'))
});

task('concat-develop-sources', function () {
    return gulp.src(sourceFiles)
        .pipe(concat('bundle.js'))
        .pipe(gulp.dest('dist/dev/js/'));
});

task('concat-develop-vendors', function () {
    return gulp.src(meta.vendors)
        .pipe(concat('vendors.js'))
        .pipe(gulp.dest('dist/dev/js/'));
});

task('clean', function (done) {
    run('sh', ['scripts/clean.sh']).then(() => done());
});

task('eslint', function (done) {
    run('sh', ['scripts/eslint.sh']).then(() => done());
});

task('less', function (done) {
    run('sh', ['scripts/less.sh']).then(() => done());
});

task('babel', ['concat-develop'], function () {
    return gulp.src('dist/dev/js/bundle.js')
        .pipe(babel({
            presets: ['es2015']
        }))
        .pipe(gulp.dest('dist/dev/js'));
});

task('uglify', ['babel'], function () {
    return gulp.src('dist/dev/js/bundle.js')
        .pipe(uglify())
        .pipe(rename('bundle.min.js'))
        .pipe(gulp.dest('dist/dev/js'));
});

task('html-develop', function (done) {
    readFile('src/index.html', { encoding: 'utf8' }).then((file) => {
        const filter = moveTo('./dist/dev');
        const files = [
            './dist/dev/js/config.js',
            'dist/dev/js/vendors.js'
        ]
            .concat(/*'./dist/dev/js/bundle.min.js'*/sourceFiles, './dist/dev/js/templates.js')
            .map(filter);

        file = replaceStyles(file, meta.stylesheets.map(filter));
        file = replaceScripts(file, files);

        Promise.all([
            outputFile('./dist/dev/index.html', file),
            outputFile('./dist/dev/js/config.js', getConfigFile('devel', meta.configurations.testnet))
        ])
            .then(() => done());
    });
});


task('copy-fonts', function () {
    return gulp.src('src/fonts/**/*.*')
        .pipe(copy('dist/dev', { prefix: 1 }));
});

task('copy-img', function () {
    return gulp.src('src/img/**/*.*')
        .pipe(copy('dist/dev', { prefix: 1 }));
});

task('s3-testnet', function () {
    const bucket = 'testnet.waveswallet.io';
    return gulp.src('./dist/testnet/**/*')
        .pipe(s3({ ...AWS, bucket }));
});

task('s3-mainnet', function () {
    const bucket = 'waveswallet.io';
    return gulp.src('./dist/mainnet/**/*')
        .pipe(s3({ ...AWS, bucket }));
});

task('s3', ['s3-testnet', 's3-mainnet']);

task('copy-develop', [
    'copy-fonts',
    'copy-img'
]);

task('concat-develop', [
    'concat-develop-sources',
    'concat-develop-vendors'
]);

task('copy', configurations.map(name => `copy-${name}`).concat('copy-develop'));
task('html', configurations.map(name => `html-${name}`).concat('html-develop'));
task('concat', configurations.map(name => `concat-${name}`).concat('concat-style'));
task('zip', configurations.map(name => `zip-${name}`));

task('build-local', [
    'less',
    'templates',
    'concat-develop-vendors',
    'copy-develop',
    'html-develop'
]);

task('all', [
    'clean',
    'concat',
    'copy',
    'html',
    'zip'
]);
