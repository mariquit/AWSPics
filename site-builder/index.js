var AWS = require("aws-sdk");
var s3 = new AWS.S3();
var cloudfront = new AWS.CloudFront();

var async = require('async');
var fs = require('fs');
var mime = require('mime');
var path = require('path');
var yaml = require('js-yaml');

var walk = function(dir, done) {
  var results = [];
  fs.readdir(dir, function(err, list) {
    if (err) return done(err);
    var pending = list.length;
    if (!pending) return done(null, results);
    list.forEach(function(file) {
      file = path.resolve(dir, file);
      fs.stat(file, function(err, stat) {
        if (stat && stat.isDirectory()) {
          walk(file, function(err, res) {
            results = results.concat(res);
            if (!--pending) done(null, results);
          });
        } else {
          results.push(file);
          if (!--pending) done(null, results);
        }
      });
    });
  });
};

function stripPrefix(object) {
  return object.Key.replace('pics/original/', '');
}

function folderName(path) {
  return path.split('/')[0];
}

function getAlbums(data) {
  var objects = data.Contents.sort(function(a,b){
    return b.LastModified - a.LastModified;
  }).map(stripPrefix);
  var albums = objects.map(folderName);
  // Deduplicate albums
  albums = albums.filter(function(item, pos) {
      return albums.indexOf(item) == pos;
  });

  var pictures = albums.map(function(album){
    return objects.filter(function(object){
      return object.startsWith(album + "/") && object.endsWith('.jpg');
    });
  });

  return {albums: albums, pictures: pictures};
}

function uploadHomepageSite(albums, pictures, metadata) {
  var dir = 'multiverse';
  walk(dir, function(err, files) {
    if (err) throw err;

    async.map(files, function(f, cb) {
      var body = fs.readFileSync(f);

      if (path.basename(f) == '.DS_Store' || f.includes('assets/sass/')) {
        return;
      } else if (path.basename(f) == 'index.html') {
        var replacement = '';
        for (var i = 0; i < albums.length; i++) {
          var albumTitle = albums[i];
          if (metadata[i] && metadata[i].title) {
            albumTitle = metadata[i].title;
          }
          replacement += "\t\t\t\t\t\t<article class=\"thumb\">\n" +
                          "\t\t\t\t\t\t\t<a href=\"" + albums[i] + "/index.html\" class=\"image\"><img src=\"/pics/resized/360x225/" + pictures[i][0] + "\" alt=\"\" /></a>\n" +
                          "\t\t\t\t\t\t\t<h2>" + albumTitle + "</h2>\n" +
                          "\t\t\t\t\t\t</article>\n";
        }
        body = body.toString().replace('{articles}', replacement);
      }

      var options = {
        Bucket: process.env.SITE_BUCKET,
        Key: path.relative(dir, f),
        Body: body,
        ContentType: mime.lookup(path.extname(f))
      };

      s3.putObject(options, cb);
    }, function(err, results) {
      if (err) console.log(err, err.stack);
    });
  });
}

function invalidateCloudFront() {
  cloudfront.listDistributions(function(err, data) {
    // Handle error
    if (err) {
      console.log(err, err.stack);
      return;
    }

    // Get distribution ID from domain name
    var distributionID = data.Items.find(function (d) {
        return d.DomainName == process.env.CLOUDFRONT_DISTRIBUTION_DOMAIN;
    }).Id;

    // Create invalidation
    cloudfront.createInvalidation({
      DistributionId: distributionID,
      InvalidationBatch: {
        CallerReference: 'site-builder-' + Date.now(),
        Paths: {
          Quantity: 1,
          Items: [
            '/*'
          ]
        }
      }
    }, function(err, data) {
      if (err) console.log(err, err.stack);
    });
  });
}

function getAlbumMetadata(album, cb) {
  s3.getObject({
    "Bucket": process.env.ORIGINAL_BUCKET,
    "Key": "pics/original/" + album + "/metadata.yml"
  }, function(err, data) {
    if (err) {
      cb(null, null);
    } else {
      try {
        var doc = yaml.safeLoad(data.Body.toString());
        cb(null, doc);
      } catch (err) {
        cb(null, null);
      }
    }
  });
}

exports.handler = function(event, context) {
  // List all bucket objects
  s3.listObjectsV2({Bucket: process.env.ORIGINAL_BUCKET}, function(err, data) {
    // Handle error
    if (err) {
      console.log(err, err.stack);
      return;
    }

    // Parse albums
    var albumsAndPictures = getAlbums(data);

    // Get metadata for all albums
    async.map(albumsAndPictures.albums, getAlbumMetadata, function(err, metadata) {
      // Upload homepage site
      uploadHomepageSite(albumsAndPictures.albums, albumsAndPictures.pictures, metadata);

      // Invalidate CloudFront
      invalidateCloudFront();
    });
  });
};
