'use strict';

/*
  Secure Chat - Web Push server

  Requirements:
    Node.js 18+
    npm install web-push

  Environment:
    PUSH_PORT=8787
    VAPID_PUBLIC_KEY=...
    VAPID_PRIVATE_KEY=...
    VAPID_SUBJECT=mailto:admin@example.com
    SECURE_CHAT_URL=https://example.com/
    PUSH_INTERNAL_TOKEN=...

  Important:
    VAPID_PRIVATE_KEY と PUSH_INTERNAL_TOKEN は
    Chat.html に入れないでください。
*/

const http = require('node:http');
const webpush = require('web-push');

const PORT =
  Number(
    process.env.PUSH_PORT || 8787
  );

const PUBLIC_KEY =
  String(
    process.env.VAPID_PUBLIC_KEY || ''
  ).trim();

const PRIVATE_KEY =
  String(
    process.env.VAPID_PRIVATE_KEY || ''
  ).trim();

const SUBJECT =
  String(
    process.env.VAPID_SUBJECT ||
    'mailto:admin@example.com'
  ).trim();

const SECURE_CHAT_URL =
  String(
    process.env.SECURE_CHAT_URL || '/'
  ).trim();

const INTERNAL_TOKEN =
  String(
    process.env.PUSH_INTERNAL_TOKEN || ''
  ).trim();

const MAX_BODY =
  512 * 1024;

if(
  !PUBLIC_KEY ||
  !PRIVATE_KEY ||
  !INTERNAL_TOKEN
){
  console.error(
    'Missing required environment variables: ' +
    'VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, ' +
    'PUSH_INTERNAL_TOKEN'
  );

  process.exit(1);
}

webpush.setVapidDetails(
  SUBJECT,
  PUBLIC_KEY,
  PRIVATE_KEY
);

/*
  peerId -> PushSubscription
*/
const subscriptions =
  new Map();


/* =========================================================
   Response helpers
   ========================================================= */

function json(
  res,
  status,
  value
){
  const body =
    JSON.stringify(
      value
    );

  res.writeHead(
    status,
    {
      'Content-Type':
        'application/json; charset=utf-8',

      'Cache-Control':
        'no-store',

      'Access-Control-Allow-Origin':
        '*',

      'Access-Control-Allow-Headers':
        'content-type, x-push-token',

      'Access-Control-Allow-Methods':
        'GET, POST, OPTIONS'
    }
  );

  res.end(
    body
  );
}


/* =========================================================
   Request body
   ========================================================= */

function readBody(
  req
){
  return new Promise(
    (resolve,reject)=>{
      let raw='';
      let settled=false;

      const fail=
        error=>{
          if(settled)return;

          settled=true;

          reject(
            error
          );
        };

      req.on(
        'data',
        chunk=>{
          raw+=chunk;

          if(
            Buffer.byteLength(
              raw,
              'utf8'
            ) >
            MAX_BODY
          ){
            fail(
              new Error(
                'request too large'
              )
            );

            try{
              req.destroy();
            }catch{}
          }
        }
      );

      req.on(
        'end',
        ()=>{
          if(settled)return;

          settled=true;

          try{
            resolve(
              raw
                ? JSON.parse(raw)
                : {}
            );
          }catch{
            reject(
              new Error(
                'invalid JSON'
              )
            );
          }
        }
      );

      req.on(
        'error',
        fail
      );
    }
  );
}


/* =========================================================
   Validation
   ========================================================= */

function validPeerId(
  id
){
  return /^\d{6}$/.test(
    String(
      id || ''
    ).trim()
  );
}


function validName(
  name
){
  const value =
    String(
      name || 'ユーザー'
    ).trim();

  return (
    value.length > 0 &&
    value.length <= 80
  );
}


function validSubscription(
  subscription
){
  if(
    !subscription ||
    typeof subscription !==
      'object'
  ){
    return false;
  }

  if(
    typeof subscription.endpoint !==
      'string'
  ){
    return false;
  }

  if(
    !/^https:\/\//i.test(
      subscription.endpoint
    )
  ){
    return false;
  }

  if(
    subscription.keys &&
    typeof subscription.keys !==
      'object'
  ){
    return false;
  }

  return true;
}


function requireInternalToken(
  req
){
  return (
    req.headers[
      'x-push-token'
    ] ===
    INTERNAL_TOKEN
  );
}


/* =========================================================
   URL
   ========================================================= */

function sanitizeUrl(
  value
){
  const raw =
    String(
      value ||
      SECURE_CHAT_URL
    ).trim();

  try{

    if(
      raw === '/'
    ){
      return '/';
    }

    const url =
      new URL(
        raw
      );

    if(
      url.protocol !==
        'https:' &&
      url.protocol !==
        'http:'
    ){
      return '/';
    }

    return url.toString();

  }catch{

    return '/';

  }
}


/* =========================================================
   Send push
   ========================================================= */

async function sendPush(
  peerId,
  payload
){
  const id =
    String(
      peerId || ''
    ).trim();

  if(
    !validPeerId(id)
  ){
    return {
      ok:false,
      status:400,
      error:'invalid peerId'
    };
  }

  const subscription =
    subscriptions.get(
      id
    );

  if(
    !subscription
  ){
    return {
      ok:false,
      status:404,
      error:'no subscription'
    };
  }

  try{

    await webpush.sendNotification(
      subscription,
      JSON.stringify(
        payload
      ),
      {
        TTL:300
      }
    );

    return {
      ok:true,
      status:200
    };

  }catch(error){

    const status =
      Number(
        error?.statusCode || 0
      );

    /*
      Push購読が無効になっていたら削除
    */

    if(
      status === 404 ||
      status === 410
    ){
      subscriptions.delete(
        id
      );
    }

    return {
      ok:false,
      status:
        status || 502,

      error:
        error?.message ||
        String(error)
    };
  }
}


/* =========================================================
   Peer connected notification
   ========================================================= */

async function notifyPeerConnected(
  peerId,
  displayName='ユーザー'
){
  const id =
    String(
      peerId || ''
    ).trim();

  const name =
    validName(
      displayName
    )
      ? String(
          displayName
        ).trim()
      : 'ユーザー';

  return sendPush(
    id,
    {
      title:
        `${name} が接続しようとしています`,

      body:
        'Secure Chatを開いて確認してください。',

      type:
        'peer-connected',

      peerId:
        id,

      name:
        name,

      url:
        sanitizeUrl(
          SECURE_CHAT_URL
        ),

      tag:
        `secure-chat-peer-${id}`,

      timestamp:
        Date.now()
    }
  );
}


/* =========================================================
   Message notification
   ========================================================= */

async function notifyMessage(
  peerId,
  displayName='ユーザー',
  preview='新しいメッセージがあります'
){
  const id =
    String(
      peerId || ''
    ).trim();

  const name =
    validName(
      displayName
    )
      ? String(
          displayName
        ).trim()
      : 'ユーザー';

  const body =
    String(
      preview ||
      '新しいメッセージがあります'
    ).slice(
      0,
      160
    );

  return sendPush(
    id,
    {
      title:
        `${name}から新着メッセージ`,

      body:

        body,

      type:
        'message',

      peerId:
        id,

      name:
        name,

      url:
        sanitizeUrl(
          SECURE_CHAT_URL
        ),

      tag:
        `secure-chat-message-${id}`,

      timestamp:
        Date.now()
    }
  );
}


/* =========================================================
   HTTP server
   ========================================================= */

const server =
  http.createServer(
    async(
      req,
      res
    )=>{

      /*
        CORS preflight
      */

      if(
        req.method ===
        'OPTIONS'
      ){
        return json(
          res,
          204,
          {}
        );
      }


      /*
        Health
      */

      if(
        req.method ===
          'GET' &&
        req.url ===
          '/health'
      ){
        return json(
          res,
          200,
          {
            ok:true,

            service:
              'secure-chat-push',

            subscriptions:
              subscriptions.size,

            timestamp:
              Date.now()
          }
        );
      }


      /*
        Public VAPID key

        PRIVATE KEYは絶対に返さない
      */

      if(
        req.method ===
          'GET' &&
        req.url ===
          '/api/vapid-public-key'
      ){
        return json(
          res,
          200,
          {
            publicKey:
              PUBLIC_KEY
          }
        );
      }


      try{

        /*
          Subscribe
        */

        if(
          req.method ===
            'POST' &&
          req.url ===
            '/api/push/subscribe'
        ){

          const body =
            await readBody(
              req
            );

          const peerId =
            String(
              body.peerId || ''
            ).trim();

          const subscription =
            body.subscription;


          if(
            !validPeerId(
              peerId
            )
          ){
            return json(
              res,
              400,
              {
                ok:false,
                error:
                  'invalid peerId'
              }
            );
          }


          if(
            !validSubscription(
              subscription
            )
          ){
            return json(
              res,
              400,
              {
                ok:false,
                error:
                  'invalid subscription'
              }
            );
          }


          subscriptions.set(
            peerId,
            subscription
          );


          return json(
            res,
            200,
            {
              ok:true,

              peerId:

                peerId,

              publicKey:
                PUBLIC_KEY
            }
          );
        }


        /*
          Unsubscribe
        */

        if(
          req.method ===
            'POST' &&
          req.url ===
            '/api/push/unsubscribe'
        ){

          const body =
            await readBody(
              req
            );

          const peerId =
            String(
              body.peerId || ''
            ).trim();


          if(
            !validPeerId(
              peerId
            )
          ){
            return json(
              res,
              400,
              {
                ok:false,
                error:
                  'invalid peerId'
              }
            );
          }


          subscriptions.delete(
            peerId
          );


          return json(
            res,
            200,
            {
              ok:true,
              peerId
            }
          );
        }


        /*
          Peer connected push
        */

        if(
          req.method ===
            'POST' &&
          req.url ===
            '/api/push/notify-peer-connected'
        ){

          if(
            !requireInternalToken(
              req
            )
          ){
            return json(
              res,
              401,
              {
                ok:false,
                error:
                  'unauthorized'
              }
            );
          }


          const body =
            await readBody(
              req
            );


          const result =
            await notifyPeerConnected(
              body.peerId,
              body.name ||
                'ユーザー'
            );


          return json(
            res,
            result.status ||
              (
                result.ok
                  ? 200
                  : 500
              ),
            result
          );
        }


        /*
          Message push
        */

        if(
          req.method ===
            'POST' &&
          req.url ===
            '/api/push/notify-message'
        ){

          if(
            !requireInternalToken(
              req
            )
          ){
            return json(
              res,
              401,
              {
                ok:false,
                error:
                  'unauthorized'
              }
            );
          }


          const body =
            await readBody(
              req
            );


          const result =
            await notifyMessage(
              body.peerId,
              body.name ||
                'ユーザー',
              body.preview ||
                '新しいメッセージがあります'
            );


          return json(
            res,
            result.status ||
              (
                result.ok
                  ? 200
                  : 500
              ),
            result
          );
        }


        return json(
          res,
          404,
          {
            ok:false,
            error:'not found'
          }
        );

      }catch(error){

        console.error(
          '[push-server]',
          error
        );


        return json(
          res,
          500,
          {
            ok:false,

            error:
              error?.message ||
              String(error)
          }
        );
      }
    }
  );


/* =========================================================
   Client errors
   ========================================================= */

server.on(
  'clientError',
  (
    error,
    socket
  )=>{

    try{

      socket.end(
        'HTTP/1.1 400 Bad Request\r\n\r\n'
      );

    }catch{}

    console.error(
      '[clientError]',
      error?.message ||
        error
    );
  }
);


/* =========================================================
   Start
   ========================================================= */

server.listen(
  PORT,
  ()=>{
    console.log(
      `Secure Chat Push server listening on :${PORT}`
    );

    console.log(
      `Health: http://localhost:${PORT}/health`
    );

    console.log(
      'Public VAPID key: /api/vapid-public-key'
    );

    console.log(
      'Register: POST /api/push/subscribe'
    );

    console.log(
      'Unregister: POST /api/push/unsubscribe'
    );

    console.log(
      'Internal connect notify: POST /api/push/notify-peer-connected'
    );

    console.log(
      'Internal message notify: POST /api/push/notify-message'
    );
  }
);


/* =========================================================
   Exports
   ========================================================= */

module.exports={
  server,
  subscriptions,
  notifyPeerConnected,
  notifyMessage
};