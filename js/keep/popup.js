let obj = JSON.parse($response.body);
if (obj.data.popUpCode){
    let popUpCode = obj.data.popUpCode;
    let errorCode = obj.errorCode = $persistenStore.read(errorCode);
    let ok = obj.ok = $persistentStore.read(ok);
    let body = JSON.stringify(obj);
    $done({body})
    $notification.post("keep_popup",`popUpCode:${popUpCode}, errorCode:${errorCode}, ok:${ok}`);
}else{
    $done({})
}