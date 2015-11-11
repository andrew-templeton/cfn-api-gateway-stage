
var fs = require('fs');
var path = require('path');
var https = require('https');

var AWS = require('aws-sdk');
var aws4 = require('aws4');

var StageSchema = JSON.parse(fs.readFileSync(path.resolve(__dirname,
  'src', 'schema.json').toString()));

var credentials = new AWS.EnvironmentCredentials('AWS');
var signingOptions = {
  accessKeyId: credentials.accessKeyId,
  secretAccessKey: credentials.secretAccessKey,
  sessionToken: credentials.sessionToken
};

var CfnLambda = require('cfn-lambda');

exports.handler = ApiGatewayStageHandler;

function ApiGatewayStageHandler(event, context) {
  var ApiGatewayStage = CfnLambda({
    Create: Create,
    Update: Update,
    Delete: Delete,
    Validate: StageSchema,
    NoUpdate: NoUpdate
  });
  // Not sure if there's a better way to do this...
  AWS.config.region = currentRegion(context);
  var APIG = new AWS.APIGateway({apiVersion: '2015-07-09'});
  
  return ApiGatewayStage(event, context);


  function Create(params, reply) {
    APIGcreateStage(params, handleReply(reply));
  }

  function Update(physicalId, params, oldParams, reply) {
    // Full replace
    if (!['RestApiId', 'Name'].every(same)) {
      return Create(params, function(creationError) {
        if (creationError) {
          return reply(creationError);
        }
        Delete(physicalId, oldParams, reply);
      });
    }
    var params = {
      deploymentId: physicalId,
      restApiId: params.RestApiId
      patchOperations: []
    };

    [
      'DeploymentId',
      'Description',
      'CacheClusterEnabled',
      'CacheClusterSize',
      'Variables'
    ].forEach(patch);

    APIG.updateStage(params, handleReply(reply));

    function patch(key) {
      var keyPath = '/' + key.toLowerCase();
      if (params[key] === oldParams[key]) {
        return;
      }
      if (!oldParams[key]) {
        return params.patchOperations.push({
          op: 'add',
          path: keyPath,
          value: params[key]
        });
      }
      if (!params[key]) {
        return params.patchOperations.push({
          op: 'remove',
          path: keyPath
        });
      }
      params.patchOperations.push({
        op: 'replace',
        path: keyPath,
        value: params[key]
      });
    }

    function same(key) {
      return params[key] === oldParams[key];
    }
  }
  

  function Delete(physicalId, params, reply) {
    APIG.deleteStage({
      deploymentId: physicalId,
      restApiId: params.RestApiId
    }, function(err, data) {
      // Already deleted, which is fine
      if (!err || err.statusCode === 404) {
        return reply();
      }
      reply(err.message);
    });
  }

  function APIGcreateStage(params, reply) {
    var body = {
      stageName: params.Name,
      description: params.Description,
      cacheClusterEnabled: params.CacheClusterEnabled,
      cacheClusterSize: params.CacheClusterSize,
      variables: params.Variables
    };
    var options = {
      service: 'apigateway',
      region: currentRegion(context),
      method: 'POST',
      path: '/restapis/' + params.RestApiId + '/stages',
      body: body
    };
    var signedRequest = aws4.sign(options, signingOptions);
    var req = https.request(opts, function(res) {
      var buffer = [];
      res.on('data', function(chunk) {
        buffer.push(chunk);
      });
      res.on('end', function() {
        var code = res.statusCode;
        var body = buffer.join('');
        var json;
        try {
          var json = JSON.parse(body);
        } catch (err) {
          return reply(err);
        }
        if (code < 400 && code >= 200){
          reply(null, json);
        } else {
          reply(json.message);
        }
      });
    });
  }

  function NoUpdate(old, fresh) {
    return [
      'RestApiId',
      'Name',
      'DeploymentId',
      'Description',
      'CacheClusterEnabled',
      'CacheClusterSize'
    ].every(function(key) {
      return old[key] === fresh[key];
    }) && Object.keys(old.Variables || {}).every(function(ok) {
      return old[ok] === fresh[ok];
    }) && Object.keys(fresh.Variables || {}).every(function(fk) {
      return old[fk] === fresh[fk];
    });
  }

};

function handleReply(reply) {
  return function(err, stage) {
    if (err) {
      console.error(err.message);
      return reply(err);
    }
    reply(null, stage.id);
  };
}

function currentRegion(context) {
  return context.invokedFunctionArn.match(/^arn:aws:lambda:(\w+-\w+-\d+):/)[1];
}
