let body = $response.body;
let obj = JSON.parse(body);
let like = 999;
obj.data[0].notifyCount.feedlike = like;
console.log("fun.js:feedlike will be: ",like)
body = JSON.stringify(obj)
$done(body)