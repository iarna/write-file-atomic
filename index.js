'use strict'
module.exports = writeFile
module.exports.sync = writeFileSync
module.exports._getTmpname = getTmpname // for testing

var fs = require('graceful-fs')
var MurmurHash3 = require('imurmurhash')
var path = require('path')
var activeFiles = {}

var invocations = 0
function getTmpname (filename) {
  return filename + '.' +
    MurmurHash3(__filename)
      .hash(String(process.pid))
      .hash(String(++invocations))
      .result()
}

function writeFile (filename, data, options, callback) {
  if (options instanceof Function) {
    callback = options
    options = null
  }
  if (!options) options = {}

  var CustomPromise = options.Promise || Promise
  function promisify (action) {
    function thenable () {
      return new CustomPromise(action)
    }
    thenable.then = function (next) { // lets promisify be the start of a promise chain
      return thenable().then(next)
    }
    return thenable
  }

  var truename
  var fd
  var tmpfile
  var absoluteName = path.resolve(filename)
  promisify(function serializeSameFile (resolve) {
    // make a queue if it doesn't already exist
    if (!activeFiles[absoluteName]) activeFiles[absoluteName] = []

    activeFiles[absoluteName].push(resolve) // add this job to the queue
    if (activeFiles[absoluteName].length === 1) resolve() // kick off the first one
  }).then(promisify(function getRealPath (resolve) {
    fs.realpath(filename, function (_, realname) {
      truename = realname || filename
      tmpfile = getTmpname(truename)
      resolve()
    })
  })).then(promisify(function stat (resolve) {
    if (options.mode && options.chown) resolve()
    else {
      // Either mode or chown is not explicitly set
      // Default behavior is to copy it from original file
      fs.stat(truename, function (err, stats) {
        if (err || !stats) resolve()
        else {
          options = Object.assign({}, options)

          if (!options.mode) {
            options.mode = stats.mode
          }
          if (!options.chown && process.getuid) {
            options.chown = { uid: stats.uid, gid: stats.gid }
          }
          resolve()
        }
      })
    }
  })).then(promisify(function thenWriteFile (resolve, reject) {
    fs.open(tmpfile, 'w', options.mode, function (err, _fd) {
      fd = _fd
      if (err) reject(err)
      else resolve()
    })
  })).then(promisify(function write (resolve, reject) {
    if (Buffer.isBuffer(data)) {
      fs.write(fd, data, 0, data.length, 0, function (err) {
        if (err) reject(err)
        else resolve()
      })
    } else if (data != null) {
      fs.write(fd, String(data), 0, String(options.encoding || 'utf8'), function (err) {
        if (err) reject(err)
        else resolve()
      })
    } else resolve()
  })).then(promisify(function syncAndClose (resolve, reject) {
    if (options.fsync !== false) {
      fs.fsync(fd, function (err) {
        if (err) reject(err)
        else fs.close(fd, resolve)
      })
    } else resolve()
  })).then(promisify(function chown (resolve, reject) {
    if (options.chown) {
      fs.chown(tmpfile, options.chown.uid, options.chown.gid, function (err) {
        if (err) reject(err)
        else resolve()
      })
    } else resolve()
  })).then(promisify(function chmod (resolve, reject) {
    if (options.mode) {
      fs.chmod(tmpfile, options.mode, function (err) {
        if (err) reject(err)
        else resolve()
      })
    } else resolve()
  })).then(promisify(function rename (resolve, reject) {
    fs.rename(tmpfile, truename, function (err) {
      if (err) reject(err)
      else resolve()
    })
  })).then(function success () {
    callback()
  }).catch(function fail (err) {
    fs.unlink(tmpfile, function () {
      callback(err)
    })
  }).then(function checkQueue () {
    activeFiles[absoluteName].shift() // remove the element added by serializeSameFile
    if (activeFiles[absoluteName].length > 0) {
      activeFiles[absoluteName][0]() // start next job if one is pending
    } else delete activeFiles[absoluteName]
  })
}

function writeFileSync (filename, data, options) {
  if (!options) options = {}
  try {
    filename = fs.realpathSync(filename)
  } catch (ex) {
    // it's ok, it'll happen on a not yet existing file
  }
  var tmpfile = getTmpname(filename)

  try {
    if (!options.mode || !options.chown) {
      // Either mode or chown is not explicitly set
      // Default behavior is to copy it from original file
      try {
        var stats = fs.statSync(filename)
        options = Object.assign({}, options)
        if (!options.mode) {
          options.mode = stats.mode
        }
        if (!options.chown && process.getuid) {
          options.chown = { uid: stats.uid, gid: stats.gid }
        }
      } catch (ex) {
        // ignore stat errors
      }
    }

    var fd = fs.openSync(tmpfile, 'w', options.mode)
    if (Buffer.isBuffer(data)) {
      fs.writeSync(fd, data, 0, data.length, 0)
    } else if (data != null) {
      fs.writeSync(fd, String(data), 0, String(options.encoding || 'utf8'))
    }
    if (options.fsync !== false) {
      fs.fsyncSync(fd)
    }
    fs.closeSync(fd)
    if (options.chown) fs.chownSync(tmpfile, options.chown.uid, options.chown.gid)
    if (options.mode) fs.chmodSync(tmpfile, options.mode)
    fs.renameSync(tmpfile, filename)
  } catch (err) {
    try { fs.unlinkSync(tmpfile) } catch (e) {}
    throw err
  }
}
