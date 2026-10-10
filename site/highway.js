
(function(){
  "use strict";
  /* ============ FIREBASE PROJECT ============ */
  var FIREBASE_CONFIG = {
    apiKey:            "AIzaSyDmAMnxfBorxPkwt4Y2FjhkEB83914ut1U",
    authDomain:        "highway-chat.firebaseapp.com",
    projectId:         "highway-chat",
    storageBucket:     "highway-chat.firebasestorage.app",
    messagingSenderId: "1063748874829",
    appId:             "1:1063748874829:web:5565a2fa6012a0c3b76204"
  };

  /* ============ DEVICE ID (per-tab identity) ============ */
  var DEVICE_ID = sessionStorage.getItem("hw_device_id");
  if(!DEVICE_ID){
    DEVICE_ID = "d-" + Math.random().toString(36).slice(2,10) + Date.now().toString(36);
    sessionStorage.setItem("hw_device_id", DEVICE_ID);
  }

  var PLATFORM = (function(){
    var ua = navigator.userAgent || "";
    if(/iPhone|iPad|iPod/i.test(ua)) return "iOS";
    if(/Android/i.test(ua)) return "Android";
    if(/Mac/i.test(ua)) return (navigator.maxTouchPoints > 1) ? "iOS" : "Mac"; // iPad reports as Mac
    if(/Win/i.test(ua)) return "PC";
    if(/Linux/i.test(ua)) return "PC";
    return "Other";
  })();
  (function(){
    if(PLATFORM==="iOS")document.body.classList.add("device-ios");
    var db=document.getElementById("devbadge");
    if(db)db.textContent=PLATFORM;
  })();

  var $ = function(id){ return document.getElementById(id); };
  var chat=$("chat"), msg=$("msg"), sendBtn=$("send"),
      gate=$("gate"), nameIn=$("name"), joinBtn=$("join"),
      err=$("err"), sub=$("sub"), dot=$("livedot"), mebadge=$("mebadge"),
      presenceEl=$("presence"), typingEl=$("typing");
  var MY_NAME=null, db=null, seen={};
  var VOICE_REG={}; /* docId -> {b64, type} : voice audio out of the DOM */
  var EMOJIS=["🔥","❤️","👍","😂","💯","👀"];
  var OWNERS=["sin","grim"]; // co-owners of the Highway — case-insensitive
  function isOwner(n){ return OWNERS.indexOf(String(n||"").toLowerCase())>=0; }
  function crownHtml(n){ return isOwner(n)?'<span class="crown" title="Owner">👑</span>':""; }
  function pingify(s){ return esc(s).replace(/@([a-z0-9_]+)/gi,'<span class="ping">@$1</span>'); }

  function fmtTime(m){var n=m.tsNum||0;if(!n)return"";var d=new Date(n),h=d.getHours(),a=h>=12?"PM":"AM";return(h%12||12)+":"+("0"+d.getMinutes()).slice(-2)+" "+a;}
  function esc(s){ return String(s).replace(/[&<>"']/g, function(c){
    return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]; }); }
  function safeUrl(u){ try{ var p=new URL(u,location.href); return (p.protocol==="http:"||p.protocol==="https:")?p.href:"#"; }catch(e){ return "#"; } }

/* ============ READ METER ============
   Counts Firestore documents each listener/read delivers (cache hits and local echoes
   excluded) and reports them to the bridge every 5 minutes, so /health shows where the
   daily read quota goes. Best effort: never blocks or breaks the UI. */
var _reads={}, _readsTab=Math.random().toString(36).slice(2,12);
function meter(src, s){
  try{
    if(!s||(s.metadata&&(s.metadata.fromCache||s.metadata.hasPendingWrites))) return;
    var n=typeof s.docChanges==="function"?s.docChanges().length:1;
    _reads[src]=(_reads[src]||0)+Math.max(1,n);
  }catch(e){}
}
function flushReads(){
  try{
    var u=window.firebase&&firebase.auth&&firebase.auth().currentUser; if(!u) return;
    var counts=_reads, any=false; for(var k in counts){ if(counts[k]){ any=true; break; } } if(!any) return;
    _reads={};
    u.getIdToken().then(function(t){
      return fetch("https://highway-chat-mcp.onrender.com/metrics/reads",{method:"POST",keepalive:true,
        headers:{"Content-Type":"application/json","Authorization":"Bearer "+t},
        body:JSON.stringify({tab:_readsTab,counts:counts})});
    }).catch(function(){});
  }catch(e){}
}
setInterval(flushReads, 300000);
window.addEventListener("pagehide", flushReads);

/* Bridge reads (no Firestore listeners). Writes still use Firebase. */
var HW_BRIDGE="https://highway-chat-mcp.onrender.com";
function hwToken(){
  var u=window.firebase&&firebase.auth&&firebase.auth().currentUser;
  return u?u.getIdToken():Promise.reject(new Error("no auth"));
}
function hwGet(path){
  return hwToken().then(function(t){
    return fetch(HW_BRIDGE+path,{headers:{Authorization:"Bearer "+t}}).then(function(r){
      if(!r.ok) throw new Error("api "+r.status);
      return r.json();
    });
  });
}
function asDoc(row){
  var ts=Number(row.tsNum||row.ts||0)||0;
  var data=Object.assign({},row,{
    tsNum:ts,
    ts:{toDate:function(){return new Date(ts);},toMillis:function(){return ts;}}
  });
  return {id:row.id,data:function(){ return data; }};
}

/* ============ QUESTS / WINS / AMBIENT (inside IIFE - needs db/esc/fmtTime) ============ */
function loadQuests(){
  var el=document.getElementById("questlist"); if(!el) return;
  hwGet("/api/tasks?limit=20").then(function(body){
    var items=body.tasks||[], h='<div style="padding:12px;"><h3 style="color:var(--red);margin:0 0 12px;">\u2694\uFE0F QUEST BOARD</h3>';
    if(!items.length){ h+='<p style="color:var(--muted);">No active quests. Add one from the Tasks tab.</p>'; }
    else items.forEach(function(d){
      var done=d.done?'\u2705':'\u23F3';
      h+='<div style="padding:10px;border:1px solid var(--line);border-radius:8px;margin-bottom:8px;">'
        +'<div>'+done+' <b>'+esc(d.text||"Untitled")+'</b></div>'
        +'<div style="font-size:12px;color:var(--muted);">by '+esc(d.createdBy||"unknown")+'</div></div>';
    });
    el.innerHTML=h+'</div>';
  }).catch(function(e){ if(window.console&&console.warn) console.warn("[highway]", e&&e.message||e); });
}
function loadWins(){
  var el=document.getElementById("winlist"); if(!el) return;
  hwGet("/api/activity?limit=30").then(function(body){
    var h='<div style="padding:12px;"><h3 style="color:var(--red);margin:0 0 12px;">\uD83C\uDFC6 WIN FEED</h3>', found=0;
    (body.items||[]).forEach(function(d){
      var txt=(d.text||"").toLowerCase();
      if(/win|completed|beat|crushed|done|success/.test(txt)){ found++;
        h+='<div style="padding:8px;border-bottom:1px solid var(--line);"><div>'+esc(d.text||"")
          +'</div><div style="font-size:11px;color:var(--muted);">'+esc(d.by||"")+' \u2022 '+fmtTime({tsNum:d.ts})+'</div></div>';
      }
    });
    if(!found) h+='<p style="color:var(--muted);">No wins yet. Go get one.</p>';
    el.innerHTML=h+'</div>';
  }).catch(function(e){ if(window.console&&console.warn) console.warn("[highway]", e&&e.message||e); });
}
// Fed by /api/activity pull in goLive.
function updateAmbientStatus(snap){
  var el=document.getElementById("ambient"); if(!el||!snap) return;
  var h="";
  snap.docs.slice(0,5).forEach(function(doc){ var d=doc.data()||{};
    h+='<span style="margin-right:12px;">'+esc(d.by||"")+': '+esc((d.text||"").slice(0,40))+'</span>'; });
  el.innerHTML=h||'<span style="color:var(--muted);">Quiet on the Highway...</span>';
}
  function scrollDown(el){ requestAnimationFrame(function(){ el.scrollTop = el.scrollHeight; }); }
  function sysLine(t){
    var d=document.createElement("div"); d.className="sys"; d.textContent=t;
    chat.appendChild(d); scrollDown(chat);
  }
  function fmtTs(ts){
    try{
      var d=ts.toDate(); var now=new Date(); var diff=Math.floor((now-d)/1000);
      if(diff<60) return "just now";
      if(diff<3600){ var m=Math.floor(diff/60); return m+"m ago"; }
      if(diff<86400){ var h=Math.floor(diff/3600); return h+"h ago"; }
      if(diff<604800){ var dd=Math.floor(diff/86400); return dd+"d ago"; }
      return d.toLocaleString([], {month:"short",day:"numeric"});
    }catch(e){ return ""; }
  }

  /* ================= CHAT ================= */
  function renderMsg(doc){
    var m=doc.data(); if(!m||seen[doc.id]) return; seen[doc.id]=1;
    var _seenKeys=Object.keys(seen);
    if(_seenKeys.length>500){
      for(var _si=0;_si<200;_si++){ delete seen[_seenKeys[_si]]; var vid=_seenKeys[_si]; if(VOICE_REG[vid]) delete VOICE_REG[vid]; }
    }
    if(m.audio){ VOICE_REG[doc.id]={b64:m.audio, type:m.audioType||'audio/webm'}; }
    var mine=(m.deviceId===DEVICE_ID);
    var row=document.createElement("div");
    row.className="row "+(mine?"me-row":"them-row");
    // Canonical sort key: numeric tsNum, doc ID as tie-breaker. Fixes voice/text ordering.
    var _tsn = Number(m.tsNum) || 0;
    row.setAttribute("data-ts", String(_tsn));
    row.setAttribute("data-id", doc.id);
    var rxHtml="";
    var rx=m.reactions||{};
    Object.keys(rx).forEach(function(e){
      var users=rx[e]||[];
      rxHtml+='<span class="rx'+(users.indexOf(MY_NAME)>=0?" mine":"")+'" data-id="'+doc.id+'" data-e="'+esc(e)+'">'+esc(e)+' '+(users.length||"")+'</span>';
    });
    rxHtml+='<span class="rx rx-add" data-id="'+doc.id+'" data-e="__pick__">＋</span>';
    // Long messages: the doc carries the FULL text (no split, no attachment).
    // Collapse beyond 1000 chars for readability — tap-to-expand reveals the
    // rest inline from already-loaded data, no fetch needed.
    var _msgText=m.text||"";
    var _COLLAPSE_AT=1000;
    var _isLong=_msgText.length>_COLLAPSE_AT;
    var _shownText=_isLong?_msgText.slice(0,_COLLAPSE_AT):_msgText;
    var attHtml="";
    // File attachments (Cloudinary CDN): render inline by type.
    var _atts=(m.attachments&&m.attachments.length)?m.attachments:[];
    _atts.forEach(function(a){
      var _u=esc(a.download_url||""), _fn=esc(a.filename||"file"), _mt=String(a.mime_type||"");
      if(!_u) return;
      if(_mt.indexOf("image/")===0||a.is_image){
        attHtml+='<a href="'+_u+'" target="_blank" rel="noopener"><img src="'+_u+'" alt="'+_fn+'" loading="lazy" style="max-width:100%;max-height:320px;border-radius:10px;margin-top:6px;display:block;" /></a>';
      } else if(_mt.indexOf("audio/")===0){
        attHtml+='<audio controls preload="metadata" src="'+_u+'" style="width:100%;margin-top:6px;display:block;min-height:44px;"></audio><div style="font-size:11px;color:var(--muted);margin-top:2px;">🎵 '+_fn+'</div>';
      } else if(_mt.indexOf("video/")===0){
        attHtml+='<video controls preload="metadata" src="'+_u+'" style="max-width:100%;max-height:320px;border-radius:10px;margin-top:6px;display:block;"></video>';
      } else {
        attHtml+='<a href="'+_u+'" target="_blank" rel="noopener" download="'+_fn+'" style="display:block;margin-top:6px;padding:10px 14px;background:rgba(96,165,250,.1);border:1px solid rgba(96,165,250,.35);border-radius:10px;color:#fff;text-decoration:none;font-size:14px;">📎 '+_fn+'</a>';
      }
    });
    if(_isLong){
      attHtml+='<button class="fulltext-btn" style="background:rgba(96,165,250,.12);border:1px solid rgba(96,165,250,.4);color:#fff;border-radius:20px;padding:8px 16px;font-size:15px;cursor:pointer;margin-top:6px;display:block;">📄 long message — tap to expand</button>';
    }
    row.innerHTML='<div class="bwrap"><div class="who">'+esc(m.name||"anon")+
      (mine?"":'<span class="ver">VERIFIED</span>')+crownHtml(m.name)+
      '<span class=ts>'+fmtTime(m)+'</span></div>'+
      '<div class="bubble">'+(m.audio?'<button data-voice="'+doc.id+'" style="background:rgba(248,113,113,.15);border:1px solid rgba(248,113,113,.4);color:#fff;border-radius:20px;padding:8px 16px;font-size:16px;cursor:pointer;margin-bottom:6px;display:block;">▶ voice</button>':'')+'<span class="msg-text">'+pingify(_shownText)+'</span>'+attHtml+'</div>'+
      '<div class="reacts">'+rxHtml+'</div></div>';
    // Sorted insertion: oldest at top, newest at bottom. Numeric tsNum, doc ID tie-breaker.
    // This fixes out-of-order rendering when Firestore returns mixed-type or unsorted docs.
    (function(){
      var rows = chat.querySelectorAll(".row");
      var inserted = false;
      for(var i=0; i<rows.length; i++){
        var rts = parseFloat(rows[i].getAttribute("data-ts") || "0");
        var rid = rows[i].getAttribute("data-id") || "";
        if(_tsn < rts || (_tsn === rts && doc.id < rid)){
          chat.insertBefore(row, rows[i]);
          inserted = true;
          break;
        }
      }
      if(!inserted) chat.appendChild(row);
    })();
    /* Crimson pulse on new arrival: the room breathes */
    if(!mine){ row.classList.add("arrived"); setTimeout(function(){row.classList.remove("arrived");},1200); }
    row.querySelectorAll(".rx").forEach(function(el){
      el.addEventListener("click", function(ev){ ev.stopPropagation(); toggleReaction(el.getAttribute("data-id"), el.getAttribute("data-e")); });
    });
    row.querySelectorAll("[data-voice]").forEach(function(btn){
      btn.addEventListener("click", function(){ window.playVoice(btn.getAttribute("data-voice"), btn); });
    });
    row.querySelectorAll(".fulltext-btn").forEach(function(btn){
      btn.addEventListener("click", function(){
        var txtSpan=btn.parentNode.querySelector(".msg-text");
        var expanded=btn.getAttribute("data-expanded")==="1";
        if(expanded){
          btn.setAttribute("data-expanded","0");
          btn.textContent="📄 long message — tap to expand";
          if(txtSpan) txtSpan.innerHTML=pingify(_shownText);
        } else {
          btn.setAttribute("data-expanded","1");
          btn.textContent="📄 tap to collapse";
          if(txtSpan) txtSpan.innerHTML=pingify(_msgText);
        }
      });
    });
    scrollDown(chat);
  }
  var _pickerFor=null;
  function buildPicker(){
    var p=document.getElementById("emoji-picker");
    if(p.children.length) return;
    EMOJIS.forEach(function(e){
      var b=document.createElement("button");
      b.textContent=e;
      b.onclick=function(ev){ ev.stopPropagation(); pickEmoji(e); };
      p.appendChild(b);
    });
    document.addEventListener("click", function(){ p.classList.remove("open"); });
  }
  function showPicker(id, anchorEl){
    buildPicker();
    _pickerFor=id;
    var p=document.getElementById("emoji-picker");
    var r=anchorEl.getBoundingClientRect();
    p.style.left=Math.max(8, Math.min(window.innerWidth-290, r.left-100))+"px";
    p.style.top=Math.max(8, r.top-220)+"px";
    p.classList.remove("open"); void p.offsetWidth; p.classList.add("open");
  }
  function pickEmoji(e){
    document.getElementById("emoji-picker").classList.remove("open");
    if(_pickerFor&&e) toggleReaction(_pickerFor, e.trim().slice(0,4));
    _pickerFor=null;
  }
  function toggleReaction(id, emoji){
    if(emoji==="__pick__"){
      var els=document.querySelectorAll('.rx-add[data-id="'+id+'"]');
      showPicker(id, els.length?els[0]:document.body);
      return;
    }
    var ref=db.collection("highway_messages").doc(id);
    db.runTransaction(function(tx){
      return tx.get(ref).then(function(snap){
        var rx=(snap.data()&&snap.data().reactions)||{};
        var users=rx[emoji]||[];
        var i=users.indexOf(MY_NAME);
        if(i>=0) users.splice(i,1); else users.push(MY_NAME);
        if(users.length) rx[emoji]=users; else delete rx[emoji];
        tx.update(ref,{reactions:rx});
      });
    }).catch(function(e){ if(window.console&&console.warn) console.warn("[highway]", e&&e.message||e); });
  }
  function sendMsg(){
    var t=msg.value.trim();
    // Attachment flow: staged file uploads to Cloudinary first, then the
    // message posts with the attachment metadata. Handled by the attach module.
    if(window.HW_hasPendingFile&&window.HW_hasPendingFile()&&!window.HW_uploading){
      if(!MY_NAME||!db) return;
      window.HW_uploadAndSend(t);
      return;
    }
    if(!t||!MY_NAME||!db) return;
    msg.value=""; msg.style.height="auto"; setTyping(false); msg.focus();
    if(window.HighwayAmbient)HighwayAmbient.sendChime();
    db.collection("highway_messages").add({
      name:MY_NAME, text:t, deviceId:DEVICE_ID, reactions:{},
      ts:firebase.firestore.FieldValue.serverTimestamp(),tsNum:Date.now()
    }).catch(function(e){
      sysLine("Send failed: "+(e.message||"permission denied")+" — try rejoining.");
      msg.value=t;
    });
  }

  /* ================= VOICE MESSAGES ================= */
  var _recorder=null, _chunks=[], _recording=false;
  var voiceBtn=$("voiceBtn");
  function toggleVoice(){
    if(_recording){ stopVoice(); return; }
    if(!MY_NAME||!db){ return; }
    if(!navigator.mediaDevices||!navigator.mediaDevices.getUserMedia){
      sysLine("Voice not supported on this device."); return;
    }
    navigator.mediaDevices.getUserMedia({audio:true}).then(function(stream){
      _chunks=[];
      _recorder=new MediaRecorder(stream,{mimeType:MediaRecorder.isTypeSupported("audio/webm")?"audio/webm":"audio/mp4"});
      _recorder.ondataavailable=function(e){ if(e.data.size>0) _chunks.push(e.data); };
      _recorder.onstop=function(){
        stream.getTracks().forEach(function(t){ t.stop(); });
        var blob=new Blob(_chunks,{type:_recorder.mimeType});
        if(blob.size>800000){ sysLine("Voice message too long — keep it under 30 seconds."); return; }
        var reader=new FileReader();
        reader.onloadend=function(){
          var b64=reader.result.split(",")[1];
          db.collection("highway_messages").add({
            name:MY_NAME, text:"🎤 voice message", deviceId:DEVICE_ID, reactions:{},
            audio:b64, audioType:_recorder.mimeType,
            ts:firebase.firestore.FieldValue.serverTimestamp(),tsNum:Date.now()
          });
          sysLine("Voice message sent.");
        };
        reader.readAsDataURL(blob);
      };
      _recorder.start();
      _recording=true;
      voiceBtn.textContent="⏹"; voiceBtn.style.background="#7f1d1d";
      sysLine("Recording… tap ⏹ to send.");
      // Auto-stop at 30s
      setTimeout(function(){ if(_recording) stopVoice(); }, 30000);
    }).catch(function(e){
      sysLine("Mic access denied.");
    });
  }
  function stopVoice(){
    if(_recorder&&_recording){ _recorder.stop(); }
    _recording=false;
    voiceBtn.textContent="🎤"; voiceBtn.style.background="";
  }
  if(voiceBtn) voiceBtn.addEventListener("click", toggleVoice);

  /* Play voice messages */
  window.playVoice=function(id,btn){
    var v=VOICE_REG[id]; if(!v){ sysLine("Voice data expired \u2014 reload to replay."); return; }
    try{
      var audio=new Audio("data:"+(v.type||"audio/webm")+";base64,"+v.b64);
      btn.textContent="⏸";
      audio.onended=function(){ btn.textContent="▶"; };
      audio.play().catch(function(){ btn.textContent="▶"; });
      // Toggle pause
      btn.onclick=function(){
        if(audio.paused){ audio.play(); btn.textContent="⏸"; }
        else{ audio.pause(); btn.textContent="▶"; }
      };
    }catch(e){ sysLine("Could not play voice message."); }
  };

  /* ================= FILE ATTACHMENTS (Cloudinary via bridge) =================
     📎 button → native file picker → preview bar → upload with progress →
     Firestore message with attachments[] → inline render.
     Uploads go through the bridge POST /upload (Firebase ID token auth);
     the Cloudinary API secret never touches the browser. No dashboard
     upload preset needed. */
  window.HW_uploading=false;
  (function(){
    var BRIDGE_URL="https://highway-chat-mcp.onrender.com";
    var MAX_BYTES=10*1024*1024; // 10 MB cap — bridge enforces per-type limits
    var pendingFile=null, objectUrl=null;

    var attachBtn=$("attachBtn"), attachInput=$("attachInput"),
        attachBar=$("attachBar"), attachThumb=$("attachThumb"),
        attachName=$("attachName"), attachMeta=$("attachMeta"),
        attachProgWrap=$("attachProgWrap"), attachProg=$("attachProg"),
        attachCancel=$("attachCancel");

    function fmtSize(b){
      if(b<1024) return b+" B";
      if(b<1048576) return (b/1024).toFixed(1)+" KB";
      return (b/1048576).toFixed(1)+" MB";
    }
    function clearPending(){
      pendingFile=null;
      if(objectUrl){ try{ URL.revokeObjectURL(objectUrl); }catch(e){} objectUrl=null; }
      if(attachInput) attachInput.value="";
      if(attachBar) attachBar.style.display="none";
      if(attachProgWrap) attachProgWrap.style.display="none";
      if(attachProg) attachProg.style.width="0%";
      window.HW_uploading=false;
    }
    window.HW_hasPendingFile=function(){ return !!pendingFile; };
    window.HW_cancelAttachment=clearPending;

    if(attachBtn&&attachInput){
      attachBtn.addEventListener("click", function(){ attachInput.click(); });
      attachInput.addEventListener("change", function(){
        var f=attachInput.files&&attachInput.files[0];
        if(!f) return;
        if(f.size>MAX_BYTES){ sysLine("File too large — 10 MB max."); attachInput.value=""; return; }
        clearPending();
        pendingFile=f;
        attachName.textContent=f.name;
        attachMeta.textContent=fmtSize(f.size)+(f.type?" · "+f.type:"");
        if(f.type&&f.type.indexOf("image/")===0){
          objectUrl=URL.createObjectURL(f);
          attachThumb.src=objectUrl; attachThumb.style.display="block";
        } else {
          attachThumb.style.display="none";
        }
        attachBar.style.display="flex";
        if(msg) msg.focus();
      });
    }
    if(attachCancel) attachCancel.addEventListener("click", function(){ clearPending(); sysLine("Attachment removed."); });

    // Upload through the bridge: file → base64 → POST /upload (Firebase ID
    // token auth) → bridge uploads to Cloudinary server-side, returns the
    // public CDN URL as download_url. XHR (not fetch) keeps upload progress.
    function uploadViaBridge(file, onProgress){
      return new Promise(function(resolve, reject){
        var reader=new FileReader();
        reader.onerror=function(){ reject(new Error("Could not read file.")); };
        reader.onload=function(){
          var b64=String(reader.result||"").split(",")[1]||"";
          if(!b64){ reject(new Error("Could not read file.")); return; }
          var user=firebase.auth().currentUser;
          if(!user){ reject(new Error("Sign in again to upload.")); return; }
          user.getIdToken().then(function(token){
            var xhr=new XMLHttpRequest();
            xhr.open("POST", BRIDGE_URL+"/upload", true);
            xhr.setRequestHeader("Content-Type","application/json");
            xhr.setRequestHeader("Authorization","Bearer "+token);
            xhr.upload.onprogress=function(e){
              if(e.lengthComputable&&onProgress) onProgress(Math.round(e.loaded/e.total*100));
            };
            xhr.onload=function(){
              var res=null;
              try{ res=JSON.parse(xhr.responseText); }catch(e){}
              if(xhr.status>=200&&xhr.status<300&&res&&res.ok&&res.download_url){
                resolve(res);
              } else {
                reject(new Error((res&&res.error)||("Upload failed ("+xhr.status+")")));
              }
            };
            xhr.onerror=function(){ reject(new Error("Upload network error.")); };
            xhr.ontimeout=function(){ reject(new Error("Upload timed out.")); };
            xhr.timeout=120000;
            xhr.send(JSON.stringify({
              filename:file.name,
              mime_type:file.type||"application/octet-stream",
              data_base64:b64
            }));
          }).catch(function(){ reject(new Error("Sign in again to upload.")); });
        };
        reader.readAsDataURL(file);
      });
    }

    window.HW_uploadAndSend=function(caption){
      var f=pendingFile;
      if(!f) return;
      window.HW_uploading=true;
      attachProgWrap.style.display="block";
      attachProg.style.width="0%";
      sysLine("Uploading "+f.name+"…");
      uploadViaBridge(f, function(pct){ attachProg.style.width=pct+"%"; }).then(function(res){
        // res is the bridge's attachment metadata (Cloudinary CDN URL).
        var att={
          id:res.id||("att_"+Date.now().toString(36)),
          filename:res.filename||f.name,
          mime_type:res.mime_type||f.type||"application/octet-stream",
          size_bytes:res.size_bytes||f.size,
          storage_path:res.storage_path||"",
          download_url:res.download_url,
          is_image:!!res.is_image,
          uploaded_by:MY_NAME, uploaded_at:Date.now()
        };
        var text=(caption&&caption.trim())?caption.trim():("📎 "+f.name);
        return db.collection("highway_messages").add({
          name:MY_NAME, text:text, deviceId:DEVICE_ID, reactions:{},
          attachments:[att],
          ts:firebase.firestore.FieldValue.serverTimestamp(), tsNum:Date.now()
        });
      }).then(function(){
        clearPending();
        if(msg){ msg.value=""; msg.style.height="auto"; setTyping(false); msg.focus(); }
        if(window.HighwayAmbient)HighwayAmbient.sendChime();
        sysLine("File sent.");
      }).catch(function(e){
        window.HW_uploading=false;
        attachProgWrap.style.display="none";
        sysLine("Upload failed: "+(e.message||"unknown error")+" — file kept, tap Send to retry.");
      });
    };
  })();

  /* ================= PRESENCE (who's online) =================
     Each visible device heartbeats its doc every 45s. Anyone whose ts is fresher
     than 120s counts as online. Every heartbeat costs one read per open listener,
     so hidden tabs stop beating. Best-effort delete on tab close. */
  var HB_MS=45000, ONLINE_MS=120000;
  var _yielded=false, _hbTimer=null;
  var TAB_SESSION=Date.now();
  try{
    var _prevSess=parseInt(sessionStorage.getItem("hw_session")||"0",10)||0;
    TAB_SESSION=Math.max(Date.now(),_prevSess+1);
    sessionStorage.setItem("hw_session",String(TAB_SESSION));
  }catch(e){}
  function stopHeartbeat(){ if(_hbTimer){clearInterval(_hbTimer);_hbTimer=null;} }
  function startHeartbeat(){
    stopHeartbeat(); _yielded=false; doBeat(); kickDuplicates();
    _hbTimer=setInterval(doBeat,HB_MS); }
  document.addEventListener("visibilitychange", function(){
    if(!db||!MY_NAME||_yielded) return;
    if(document.hidden) stopHeartbeat(); else if(!_hbTimer){ doBeat(); _hbTimer=setInterval(doBeat,HB_MS); }
  });
  function kickDuplicates(){
    if(!db||!MY_NAME||_yielded) return;
    db.collection("highway_presence").where("name","==",MY_NAME).get().then(function(snap){ meter("kick",snap);
      snap.forEach(function(d){
        if(d.id===DEVICE_ID) return;
        var s=d.data()||{};
        if((s.session||0) < TAB_SESSION) d.ref.delete().catch(function(e){ if(window.console&&console.warn) console.warn("[highway]", e&&e.message||e); });
      });
    }).catch(function(e){ if(window.console&&console.warn) console.warn("[highway]", e&&e.message||e); });
  }
  function doBeat(){
    if(!db||!MY_NAME||_yielded) return;
    var myRef=db.collection("highway_presence").doc(DEVICE_ID);
    // New session takes over: claim presence, old tabs will see their doc gone and go quiet
    myRef.set({name:MY_NAME, platform:PLATFORM, ts:firebase.firestore.FieldValue.serverTimestamp(), session:TAB_SESSION}, {merge:true}).catch(function(e){ if(window.console&&console.warn) console.warn("[highway]", e&&e.message||e); });
  }
  // A newer session deleted our presence doc (seen via the presence snapshot): go idle silently.
  function onPresenceChanges(s){
    if(_yielded) return;
    s.docChanges().forEach(function(c){
      if(c.type==="removed" && c.doc.id===DEVICE_ID && !c.doc.metadata.hasPendingWrites){ _yielded=true; stopHeartbeat(); }
    });
  }
  window.addEventListener("beforeunload", function(){
    if(db) db.collection("highway_presence").doc(DEVICE_ID).delete().catch(function(e){ if(window.console&&console.warn) console.warn("[highway]", e&&e.message||e); });
  });

  /* ================= TYPING INDICATORS ================= */
  var typingTimer=null;
  function setTyping(on){
    if(!db||!MY_NAME) return;
    db.collection("highway_typing").doc(DEVICE_ID).set({
      name:MY_NAME, typing:!!on, ts:firebase.firestore.FieldValue.serverTimestamp()
    }, {merge:true});
  }

  /* ================= TASKS ================= */
  function renderTask(doc){
    var t=doc.data(); if(!t) return;
    var el=document.createElement("div");
    el.className="trow"+(t.done?" done":""); el.id="task-"+doc.id;
    el.innerHTML='<input type="checkbox" class="tcheck"'+(t.done?" checked":"")+'>'+
      '<span class="ttext">'+esc(t.text||"")+'</span>'+
      '<span class="tby">'+esc(t.createdBy||"")+'</span>'+
      '<button class="tdel">×</button>';
    el.querySelector(".tcheck").addEventListener("change", function(e){
      if(e.target.checked){ el.classList.add("completing"); setTimeout(function(){el.classList.remove("completing");},650); }
      db.collection("highway_tasks").doc(doc.id).update({done:e.target.checked});
      if(db && MY_NAME){
        var action = e.target.checked ? "completed quest" : "reopened quest";
        db.collection("highway_activity").add({text:action+": "+(t.text||"").slice(0,200), by:MY_NAME,
          ts:firebase.firestore.FieldValue.serverTimestamp()});
      }
    });
    el.querySelector(".tdel").addEventListener("click", function(){
      if(confirm("Abandon this quest?")){
        var taskText = (t.text||"").slice(0,200);
        db.collection("highway_tasks").doc(doc.id).delete();
        if(db && MY_NAME){
          db.collection("highway_activity").add({text:"abandoned quest: "+taskText, by:MY_NAME,
            ts:firebase.firestore.FieldValue.serverTimestamp()});
        }
      }
    });
    return el;
  }

  /* ================= NOTES (shared live doc) ================= */
  var notesTimer=null, notesFocused=false, lastNotesTs=null;
  function saveNotes(){
    if(!db||!MY_NAME) return;
    db.collection("highway_notes").doc("shared").set({
      content:$("notes").value.slice(0,20000),
      updatedBy:MY_NAME, ts:firebase.firestore.FieldValue.serverTimestamp()
    }, {merge:true});
  }

  /* ================= ACTIVITY FEED ================= */
  function logActivity(){
    var t=$("actin").value.trim(); if(!t||!db||!MY_NAME) return;
    $("actin").value="";
    db.collection("highway_activity").add({
      text:t.slice(0,300), by:MY_NAME,
      ts:firebase.firestore.FieldValue.serverTimestamp()
    });
  }

  /* ================= GO LIVE ================= */
  function goLive(){
    try{
      firebase.initializeApp(FIREBASE_CONFIG);
      // Sign in anonymously for authenticated Firestore access
      db=firebase.firestore();
    }
    catch(e){ sub.textContent="config error"; return; }

    dot.classList.remove("off"); sub.textContent="live";
    sysLine("Connected — chat, presence, tasks, notes & activity all sync live.");

    var _msgWatermark=0, _presReady=false, _presItems=[], _typeItems=[], _actItems=[];
    function pullMessages(){
      var q="/api/messages?channel=room&limit=50";
      if(_msgWatermark) q+="&since_ts="+_msgWatermark;
      hwGet(q).then(function(body){
        var rows=(body.messages||[]).slice().reverse();
        rows.forEach(function(m){
          if(m.ts>_msgWatermark) _msgWatermark=m.ts;
          var id=m.id;
          if(seen[id]){
            var old=document.querySelector('[data-id="'+id+'"]');
            if(old){ delete seen[id]; old.remove(); }
          }
          renderMsg(asDoc(m));
        });
      }).catch(function(){});
    }
    function renderPresence(){
      if(!presenceEl) return;
      var now=Date.now(), html="";
      _presItems.forEach(function(p){
        if(!p||!p.ts) return;
        if(now-Number(p.ts)<ONLINE_MS) html+='<span class="p-chip">'+esc(p.name)+crownHtml(p.name)+(p.platform?' <span style="font-size:9px;opacity:.55">'+esc(p.platform)+'</span>':'')+'</span>';
      });
      presenceEl.innerHTML=html||'<span style="font-size:11px;color:var(--muted)">no one else here</span>';
    }
    function pullPresence(){
      hwGet("/api/presence").then(function(body){
        _presItems=body.items||[];
        if(_presReady){
          var mine=false;
          for(var i=0;i<_presItems.length;i++) if(_presItems[i].id===DEVICE_ID) mine=true;
          if(!mine&&!_yielded){ _yielded=true; stopHeartbeat(); }
        }
        _presReady=true;
        renderPresence();
      }).catch(function(){});
    }
    function renderTyping(){
      if(!typingEl) return;
      var names=[];
      _typeItems.forEach(function(t){
        if(t&&t.typing&&t.id!==DEVICE_ID&&t.ts&&Date.now()-Number(t.ts)<8000) names.push(t.name);
      });
      typingEl.textContent=names.length?names.join(", ")+(names.length>1?" are":" is")+" typing…":"";
    }
    function pullTyping(){
      hwGet("/api/typing").then(function(body){ _typeItems=body.items||[]; renderTyping(); }).catch(function(){});
    }
    function pullTasks(){
      hwGet("/api/tasks?limit=100").then(function(body){
        var list=$("tasklist"); if(!list) return;
        var items=body.tasks||[];
        list.innerHTML="";
        items.slice().reverse().forEach(function(t){ var el=renderTask(asDoc(t)); if(el) list.appendChild(el); });
        if(!items.length) list.innerHTML='<div style="text-align:center;padding:40px 20px;color:var(--muted);">'
          +'<div style="font-size:32px;margin-bottom:12px;">⚔️</div>'
          +'<div style="font-size:15px;font-weight:600;color:var(--txt);margin-bottom:6px;">No quests on the board</div>'
          +'<div style="font-size:13px;">Every legend starts with a single step.<br>Set your first quest above.</div></div>';
      }).catch(function(){});
    }
    function pullNotes(){
      hwGet("/api/notes").then(function(body){
        var d=body.notes; if(!d) return;
        var ts=Number(d.ts)||0;
        if(!notesFocused && ts && (!lastNotesTs || ts>lastNotesTs)){
          lastNotesTs=ts;
          $("notes").value=d.content||"";
        }
        $("notes-meta").textContent=d.updatedBy?("last edited by "+d.updatedBy):"";
      }).catch(function(){});
    }
    function paintActivity(items){
      _actItems=items||[];
      updateAmbientStatus({docs:_actItems.slice(0,5).map(function(a){ return asDoc(a); })});
      var list=$("actlist"); if(!list) return;
      list.innerHTML="";
      _actItems.forEach(function(a){
        var el=document.createElement("div"); el.className="arow";
        el.innerHTML="<b>"+esc(a.by||"")+"</b> "+esc(a.text||"")+"<time>"+fmtTs({toDate:function(){return new Date(a.ts||0);}})+"</time>";
        list.appendChild(el);
      });
      if(!_actItems.length) list.innerHTML='<div style="text-align:center;padding:40px 20px;color:var(--muted);">'
        +'<div style="font-size:32px;margin-bottom:12px;">📜</div>'
        +'<div style="font-size:15px;font-weight:600;color:var(--txt);margin-bottom:6px;">The story hasn\'t begun</div>'
        +'<div style="font-size:13px;">Every message, quest, and moment<br>will be written here.</div></div>';
    }
    function pullActivity(){
      hwGet("/api/activity?limit=30").then(function(body){ paintActivity(body.items||[]); }).catch(function(){});
    }
    function pullAll(){
      pullMessages(); pullPresence(); pullTyping(); pullTasks(); pullNotes(); pullActivity();
    }
    pullAll();
    setInterval(pullAll, 8000);
    setInterval(renderPresence,15000);
    setInterval(renderTyping,5000);
    hwToken().then(function(t){
      return fetch(HW_BRIDGE+"/api/stream",{headers:{Authorization:"Bearer "+t}}).then(function(res){
        if(!res.body||!res.body.getReader) return;
        var reader=res.body.getReader(), dec=new TextDecoder(), buf="";
        function pump(){
          return reader.read().then(function(x){
            if(x.done) return;
            buf+=dec.decode(x.value,{stream:true});
            var parts=buf.split("\n\n"); buf=parts.pop();
            parts.forEach(function(block){
              var line=block.split("\n").filter(function(l){ return l.indexOf("data:")===0; })[0];
              if(!line) return;
              try{ var ev=JSON.parse(line.slice(5).trim()); if(ev&&ev.type==="messages") pullMessages(); if(ev&&ev.type==="tasks") pullTasks(); }catch(e){}
            });
            return pump();
          });
        }
        return pump();
      });
    }).catch(function(){});

    startHeartbeat();
  }

  /* ================= PASSWORD GATE ================= */
  var _PW="TheEnd";
  try{ if(sessionStorage.getItem("hw_pw")==="1"){ $("pwgate").style.display="none"; $("gate").style.display="flex"; } }catch(e){}
  function tryPw(){
    if($("pw").value===_PW){
      try{ sessionStorage.setItem("hw_pw","1"); }catch(e){}
      $("pwgate").style.display="none";
      $("gate").style.display="flex";
      $("name").focus();
    } else {
      $("pwerr").textContent="Wrong password.";
      $("pw").value=""; $("pw").focus();
    }
  }
  $("pwjoin").addEventListener("click", tryPw);
  $("pw").addEventListener("keydown", function(e){ if(e.key==="Enter") tryPw(); });

  /* ================= UI EVENTS ================= */
  var authShown=false;
  function join(){
    var n=nameIn.value.trim().slice(0,24);
    if(!n){ err.textContent="Pick a name first."; return; }
    // First click: reveal the account fields. Second click: sign in.
    if(!authShown){
      authShown=true;
      $("authfields").style.display="block";
      $("email").focus();
      err.textContent="Sign in with your Highway account.";
      return;
    }
    var email=$("email").value.trim();
    var pw=$("password").value;
    if(!email||!pw){ err.textContent="Enter your email and password."; return; }
    err.textContent="Verifying...";
    try{ firebase.initializeApp(FIREBASE_CONFIG); }catch(e){}
    firebase.auth().signInWithEmailAndPassword(email,pw).then(function(cred){
      // Name must match the account's allowed name (enforced server-side too)
      completeJoin(n,true);
    }).catch(function(e){
      var msg="Sign-in failed.";
      if(e&&e.code==="auth/user-not-found") msg="No account for that email.";
      else if(e&&e.code==="auth/wrong-password") msg="Wrong password.";
      else if(e&&e.code==="auth/invalid-email") msg="That email looks invalid.";
      err.textContent=msg+" Try again.";
    });
  }
  function completeJoin(n,verified){
    try{ firebase.auth().setPersistence(firebase.auth.Auth.Persistence.LOCAL); }catch(e){}
    MY_NAME=n;
    try{ sessionStorage.setItem("hw_name",n); localStorage.setItem("hw_name",n); }catch(e){}
    mebadge.textContent=n+(verified?" ✓":"");
    gate.style.display="none";
    kickDuplicates();
    sysLine("You joined as "+n+" — verified on everything you do.");
    goLive(); msg.focus();
  }
  joinBtn.addEventListener("click", join);
  nameIn.addEventListener("keydown", function(e){ if(e.key==="Enter") join(); });

  /* Tab glider: slides to the active tab */
  function moveGlider(){
    var active=document.querySelector(".tab.active"); var glider=document.querySelector(".tab-glider");
    var tabs=document.querySelector(".tabs");
    if(!active||!glider||!tabs) return;
    var tr=tabs.getBoundingClientRect(); var ar=active.getBoundingClientRect();
    glider.style.left=(ar.left-tr.left)+"px"; glider.style.width=ar.width+"px";
  }
  document.querySelectorAll(".tab").forEach(function(t){
    t.addEventListener("click", function(){
      document.querySelectorAll(".tab").forEach(function(x){x.classList.remove("active");});
      document.querySelectorAll(".view").forEach(function(x){x.classList.remove("active");});
      t.classList.add("active"); $(t.getAttribute("data-v")).classList.add("active");
      moveGlider();
      if(window.HighwayAmbient)HighwayAmbient.shimmer();
      if(t.getAttribute("data-v")==="view-news" && Date.now()-newsLoadedAt>10*60*1000) loadNews();
      var v=t.getAttribute("data-v");
      if(v==="view-quests") loadQuests();
      if(v==="view-wins") loadWins();
    });
  });
  window.addEventListener("resize", moveGlider);
  setTimeout(moveGlider, 300);

  /* ============ NEWS FEED (money moves: crypto + stocks + macro) ============ */
  var NEWS_URL="https://highway-chat-mcp.onrender.com/news";
  var newsLoadedAt=0;
  function loadNews(){
    var list=$("newslist"); if(!list) return;
    list.innerHTML='<div style="color:var(--muted);font-size:13px;text-align:center;padding:20px;">Pulling the money moves…</div>';
    fetch(NEWS_URL).then(function(r){ return r.json(); }).then(function(d){
      newsLoadedAt=Date.now();
      var items=(d&&d.items)||[];
      if(!items.length){ list.innerHTML='<div style="color:var(--muted);font-size:13px;text-align:center;padding:20px;">Markets are quiet right now.</div>'; return; }
      var html='<div style="color:var(--muted);font-size:11px;text-align:center;letter-spacing:.4px;">MONEY MOVES · RANKED BY WALLET IMPACT · UPDATED '+esc(new Date(d.updated||Date.now()).toLocaleTimeString())+'</div>';
      var lastSec="";
      items.forEach(function(n){
        var src=(n.source||"?").trim();
        if(src&&src!==lastSec){ lastSec=src; html+='<div class="nsec">'+esc(src)+'</div>'; }
        var initial=esc(src.charAt(0).toUpperCase());
        var img=n.image?'<img class="nthumb" src="'+esc(n.image)+'" alt="" loading="lazy" onerror="this.style.display=\'none\';this.nextElementSibling.style.display=\'flex\';">':'';
        var ph='<span class="nthumb nph" style="'+(n.image?'display:none;':'display:flex;')+'">'+initial+'</span>';
        var desc=n.description?'<span class="ndesc">'+esc(n.description)+'</span>':'';
        html+='<a class="ncard" href="'+safeUrl(n.url||"#")+'" target="_blank" rel="noopener">'
          +'<span class="nthumbwrap">'+img+ph+'</span>'
          +'<span class="nbody"><span class="nsrc">'+esc(src)+'</span>'
          +'<span class="ntitle">'+esc(n.title||"")+'</span>'+desc+'</span></a>';
      });
      list.innerHTML=html;
    }).catch(function(){
      list.innerHTML='<div style="color:var(--muted);font-size:13px;text-align:center;padding:20px;">Feed is warming up — open the tab again in a minute.</div>';
    });
  }

  sendBtn.addEventListener("click", sendMsg);
  $("clear").addEventListener("click", function(){
    if(!db||!confirm("Clear ALL chat messages for everyone? This cannot be undone.")) return;
    db.collection("highway_messages").get().then(function(s){ meter("other",s);
      var docs=[]; s.forEach(function(d){ docs.push(d.ref); });
      function next(){
        if(!docs.length) return Promise.resolve();
        var b=db.batch();
        docs.splice(0,450).forEach(function(r){ b.delete(r); });
        return b.commit().then(next);
      }
      return next();
    }).then(function(){ sysLine("Chat cleared — fresh highway."); })
    .catch(function(e){ sysLine("Clear failed: "+(e.message||e)); });
  });
  msg.addEventListener("keydown", function(e){
    if(e.key==="Enter"&&!e.shiftKey){ e.preventDefault(); sendMsg(); }
  });
  msg.addEventListener("input", function(){
    // Auto-expand textarea as you type
    msg.style.height="auto";
    msg.style.height=Math.min(msg.scrollHeight,120)+"px";
    setTyping(true);
    clearTimeout(typingTimer);
    typingTimer=setTimeout(function(){ setTyping(false); }, 2000);
  });

  $("taskadd").addEventListener("click", function(){
    var t=$("taskin").value.trim(); if(!t||!db||!MY_NAME) return;
    $("taskin").value="";
    db.collection("highway_tasks").add({text:t.slice(0,300),done:false,createdBy:MY_NAME,
      ts:firebase.firestore.FieldValue.serverTimestamp()});
    db.collection("highway_activity").add({text:"started quest: "+t.slice(0,200), by:MY_NAME,
      ts:firebase.firestore.FieldValue.serverTimestamp()});
  });
  $("taskin").addEventListener("keydown", function(e){ if(e.key==="Enter") $("taskadd").click(); });

  $("notes").addEventListener("focus", function(){ notesFocused=true; });
  $("notes").addEventListener("blur", function(){ notesFocused=false; saveNotes(); });
  $("notes").addEventListener("input", function(){
    clearTimeout(notesTimer); notesTimer=setTimeout(saveNotes, 1000);
  });

  $("actadd").addEventListener("click", logActivity);
  $("actin").addEventListener("keydown", function(e){ if(e.key==="Enter") logActivity(); });

  nameIn.focus();
}








)();


/* Liquid Glass scroll morph: tab bar shrinks on scroll down, blooms on scroll up */
(function(){
  var tabs = document.querySelector('.tabs');
  if (!tabs) return;
  var lastY = 0, ticking = false;
  function onScroll(){
    var views = document.querySelectorAll('.view.active');
    var y = 0;
    views.forEach(function(v){ y = Math.max(y, v.scrollTop); });
    if (y > 60 && y > lastY + 4) tabs.classList.add('min');
    else if (y < lastY - 4 || y < 30) tabs.classList.remove('min');
    lastY = y;
    ticking = false;
  }
  document.querySelectorAll('.view').forEach(function(v){
    v.addEventListener('scroll', function(){
      if (!ticking){ requestAnimationFrame(onScroll); ticking = true; }
    }, { passive:true });
  });
  /* Ethereal embers: slow drifting particles */
  var reduced = window.matchMedia('(prefers-reduced-motion:reduce)').matches;
  if (!reduced){
    for (var i = 0; i < 14; i++){
      var e = document.createElement('div');
      e.className = 'ember';
      var sz = 3 + Math.random() * 5;
      e.style.width = sz + 'px'; e.style.height = sz + 'px';
      e.style.left = (Math.random() * 100) + 'vw';
      e.style.top = (60 + Math.random() * 40) + 'vh';
      e.style.animationDuration = (9 + Math.random() * 8) + 's';
      e.style.animationDelay = (Math.random() * 10) + 's';
      document.body.appendChild(e);
    }
  }
  /* Luminescent trail follows touch */
  var glow = document.createElement('div');
  glow.className = 'touch-glow';
  document.body.appendChild(glow);
  var glowTimer = null;
  function showGlow(x, y){
    glow.style.left = x + 'px';
    glow.style.top = y + 'px';
    glow.style.opacity = '1';
    clearTimeout(glowTimer);
    glowTimer = setTimeout(function(){ glow.style.opacity = '0'; }, 800);
  }
  document.addEventListener('touchstart', function(e){
    if (e.touches.length > 0) showGlow(e.touches[0].clientX, e.touches[0].clientY);
  }, { passive:true });
  document.addEventListener('mousemove', function(e){
    showGlow(e.clientX, e.clientY);
  }, { passive:true });
})();


/* Highway Chat push notifications */
(function(){
  var VAPID_PUBLIC = "BEm8B9zNCKOVR7_nvgrVOrBiVUJTnWTdLkn23Wk---Y03oqTXMDjXwvTliytNJBN412Z8gU7O29YGPpTke0Papk";
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;

  function urlB64ToUint8(base64String) {
    var padding = '='.repeat((4 - base64String.length % 4) % 4);
    var base64 = (base64String + padding).replace(/\-/g, '+').replace(/_/g, '/');
    var raw = window.atob(base64);
    var out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; ++i) out[i] = raw.charCodeAt(i);
    return out;
  }

  function addBell(){
    var header = document.querySelector('.head-top') || document.body;
    var btn = document.createElement('button');
    btn.id = 'pushbell';
    btn.title = 'Enable live notifications';
    btn.textContent = '\uD83D\uDD15';
    btn.style.cssText = 'background:none;border:1px solid #c1121f;color:#c1121f;border-radius:8px;padding:4px 10px;font-size:16px;cursor:pointer;margin-left:8px;';
    btn.onclick = enablePush;
    header.appendChild(btn);
    navigator.serviceWorker.ready.then(function(reg){
      reg.pushManager.getSubscription().then(function(sub){
        if (sub) { btn.textContent = '\uD83D\uDD14'; btn.title = 'Notifications on'; }
      });
    });
  }

  function enablePush(){
    if (Notification.permission === 'denied') { alert('Notifications blocked. Enable them in Settings > Highway Chat.'); return; }
    navigator.serviceWorker.ready.then(function(reg){
      return reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8(VAPID_PUBLIC) });
    }).then(function(sub){
      var btn = document.getElementById('pushbell');
      if (btn) { btn.textContent = '\uD83D\uDD14'; btn.title = 'Notifications on'; }
      var subJson = sub.toJSON();
      if (typeof db !== 'undefined' && db) {
        var myName = 'anon';
        try { myName = sessionStorage.getItem('hw_name') || localStorage.getItem('hw_name') || 'anon'; } catch(e){}
        db.collection('highway_push_subs').doc(btoa(sub.endpoint).replace(/[^a-zA-Z0-9]/g,'').substring(0,60)).set({
          endpoint: sub.endpoint,
          keys: subJson.keys,
          name: myName,
          platform: navigator.platform || 'unknown',
          updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
      }
    }).catch(function(err){ console.warn('push subscribe failed', err); });
  }

  navigator.serviceWorker.register('sw.js').then(function(){ addBell(); }).catch(function(e){ console.warn('sw failed', e); });
})();


/* Highway ambient: procedural Web Audio (rain+pad+chords). */
(function(){
  var ctx = null, master = null, started = false;

  var CHORDS = [
    [220.00, 246.94, 329.63],  // Am(add9)
    [174.61, 220.00, 329.63],  // Fmaj9
    [196.00, 246.94, 293.66],  // Gm(add9)
    [164.81, 196.00, 293.66],  // Em(add9)
    [220.00, 277.18, 329.63],  // A(add9)
  ];
  var chordIdx = 0;

  function initAudio() {
    if (ctx) return;
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ctx = new AC();

    master = ctx.createGain();
    master.gain.value = 0.0; // start silent, fade in

    var verb = ctx.createConvolver();
    verb.buffer = makeImpulse(3.5, 2.5);
    var wet = ctx.createGain(); wet.gain.value = 0.35;
    var dry = ctx.createGain(); dry.gain.value = 0.7;
    master.connect(dry); dry.connect(ctx.destination);
    master.connect(verb); verb.connect(wet); wet.connect(ctx.destination);

    startRain();
    startPad();
    scheduleChords();
    setTimeout(dove, 5000);

    master.gain.linearRampToValueAtTime(0.45, ctx.currentTime + 3);
  }

  function makeImpulse(dur, decay) {
    var len = Math.floor(ctx.sampleRate * dur);
    var buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (var c = 0; c < 2; c++) {
      var d = buf.getChannelData(c);
      for (var i = 0; i < len; i++) {
        d[i] = (Math.random()*2-1) * Math.pow(1 - i/len, decay);
      }
    }
    return buf;
  }

  function startRain() {
    var len = ctx.sampleRate * 4;
    var buf = ctx.createBuffer(1, len, ctx.sampleRate);
    var d = buf.getChannelData(0);
    for (var i = 0; i < len; i++) d[i] = Math.random()*2-1;
    var src = ctx.createBufferSource();
    src.buffer = buf; src.loop = true;
    var bp = ctx.createBiquadFilter();
    bp.type = "bandpass"; bp.frequency.value = 1500; bp.Q.value = 0.5;
    var g = ctx.createGain(); g.gain.value = 0.03;
    var lfo = ctx.createOscillator(); lfo.frequency.value = 0.07;
    var lfoG = ctx.createGain(); lfoG.gain.value = 0.015;
    lfo.connect(lfoG); lfoG.connect(g.gain); lfo.start();
    src.connect(bp); bp.connect(g); g.connect(master);
    src.start();
  }

  function startPad() {
    var o1 = ctx.createOscillator(); o1.type = "sine"; o1.frequency.value = 110; // A2
    var o2 = ctx.createOscillator(); o2.type = "sine"; o2.frequency.value = 165; // E3
    var f = ctx.createBiquadFilter();
    f.type = "lowpass"; f.frequency.value = 320; f.Q.value = 2;
    var lfo = ctx.createOscillator(); lfo.frequency.value = 0.025;
    var lfoG = ctx.createGain(); lfoG.gain.value = 200;
    lfo.connect(lfoG); lfoG.connect(f.frequency); lfo.start();
    var g = ctx.createGain(); g.gain.value = 0.06;
    o1.connect(f); o2.connect(f); f.connect(g); g.connect(master);
    o1.start(); o2.start();
  }

  function playChord(freqs) {
    var t = ctx.currentTime;
    freqs.forEach(function(fr, i){
      var o = ctx.createOscillator();
      o.type = "sine"; o.frequency.value = fr;
      var g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.10, t + 0.6 + i*0.15);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 12);
      var tr = ctx.createOscillator(); tr.frequency.value = 3;
      var trG = ctx.createGain(); trG.gain.value = 0.008;
      tr.connect(trG); trG.connect(g.gain); tr.start(t); tr.stop(t+12.5);
      o.connect(g); g.connect(master);
      o.start(t); o.stop(t + 12.5);
    });
  }

  function scheduleChords() {
    playChord(CHORDS[chordIdx]);
    chordIdx = (chordIdx + 1) % CHORDS.length;
    setTimeout(scheduleChords, 6000 + Math.random()*3000);
  }

  function dove(){
    var t=ctx.currentTime;
    [520,640,540].forEach(function(f,i){
      var o=ctx.createOscillator(),g=ctx.createGain(),tt=t+i*0.55;
      o.frequency.value=f;
      g.gain.setValueAtTime(0,tt);
      g.gain.linearRampToValueAtTime(0.07,tt+0.1);
      g.gain.exponentialRampToValueAtTime(0.0001,tt+0.5);
      o.connect(g);g.connect(master);o.start(tt);o.stop(tt+0.55);
    });
    setTimeout(dove,15000+Math.random()*20000);
  }

  function unlock(){
    if(started)return;
    try{
      initAudio();
      if(!ctx)return;
      var st=ctx.state;
      if(st==="running"){
        started=true;
        ["touchstart","touchend","click"].forEach(function(e){window.removeEventListener(e,unlock)});
      }else{ ctx.resume(); }
    }catch(e){ if(window.console)console.warn("unlock:",e); }
  }
  window.addEventListener("touchstart", unlock, {passive: true});
  window.addEventListener("touchend", unlock, false);
  window.addEventListener("click", unlock, false);

  function tone(f,d,v){
    if(!ctx||!started)return;
    try{
      var t=ctx.currentTime,o=ctx.createOscillator(),g=ctx.createGain();
      o.frequency.value=f;
      g.gain.setValueAtTime(0.0001,t);
      g.gain.exponentialRampToValueAtTime(v,t+0.015);
      g.gain.exponentialRampToValueAtTime(0.0001,t+d);
      o.connect(g);g.connect(master);o.start(t);o.stop(t+d+0.05);
    }catch(e){}
  }
  function thock(){
    if(!ctx||!started)return;
    try{
      var t=ctx.currentTime,len=Math.floor(ctx.sampleRate*0.03),
          b=ctx.createBuffer(1,len,ctx.sampleRate),d=b.getChannelData(0);
      for(var i=0;i<len;i++)d[i]=(Math.random()*2-1)*(1-i/len);
      var s=ctx.createBufferSource();s.buffer=b,
          f=ctx.createBiquadFilter();f.type="lowpass";f.frequency.value=850,
          g=ctx.createGain();g.gain.value=0.16;
      s.connect(f);f.connect(g);g.connect(master);s.start(t);
      tone(175+Math.random()*45,0.09,0.12);
    }catch(e){}
  }
  function shimmer(){
    tone(523.25,1.4,0.045);
    setTimeout(function(){tone(784,1.8,0.035);},140);
  }
  function sendChime(){ tone(880,0.9,0.05); setTimeout(function(){tone(1174.66,1.2,0.04);},100); }
  document.addEventListener("keydown",function(e){
    var t=e.target;
    if(t&&(t.tagName==="INPUT"||t.tagName==="TEXTAREA")&&t.type!=="password"&&t.type!=="checkbox")thock();
  });

  window.HighwayAmbient = { init: function(){ unlock(); }, thock:thock, shimmer:shimmer, sendChime:sendChime, tone:tone };
})();




// ============ ROOM MOODS ============
// Time-based atmosphere
function applyMood(){
  var h = new Date().getHours();
  var b = document.body;
  b.classList.remove("mood-dawn","mood-day","mood-dusk","mood-night");
  if(h>=5 && h<8) b.classList.add("mood-dawn");
  else if(h>=8 && h<17) b.classList.add("mood-day");
  else if(h>=17 && h<20) b.classList.add("mood-dusk");
  else b.classList.add("mood-night");
}
applyMood();
setInterval(applyMood, 600000);


// ============ NEXUS IMAGE BOARD ============
// Team-only image posting, public viewing.
// Images stored as data URLs in highway_dm. Sin + agents can post.
(function initNexus(){
  var checkReady = setInterval(function(){
    if (typeof firebase === 'undefined' || !firebase.firestore) return;
    clearInterval(checkReady);
    setupNexus();
  }, 500);

  function setupNexus(){
    var db = firebase.firestore();
    var nexusChat = document.getElementById('nexus-chat');
    var nexusFoot = document.getElementById('nexus-foot');
    var nexusReadonly = document.getElementById('nexus-readonly');
    var nexusImg = document.getElementById('nexus-img');
    var nexusImgBtn = document.getElementById('nexus-imgbtn');
    if (!nexusChat) return;

    var myName = 'anon';
    try { myName = sessionStorage.getItem('hw_name') || localStorage.getItem('hw_name') || 'anon'; } catch(e){}
    var canPost = (myName.toLowerCase() === 'sin');
    if (canPost) {
      nexusFoot.style.display = '';
      if (nexusReadonly) nexusReadonly.style.display = 'none';
    }

    var _dmSeen={};
    function pullNexus(){
      hwGet("/api/messages?channel=dm&limit=50").then(function(body){
        (body.messages||[]).slice().reverse().forEach(function(m){
          if(_dmSeen[m.id]) return;
          _dmSeen[m.id]=1;
          renderNexusImg(asDoc(m));
        });
        nexusChat.scrollTop = nexusChat.scrollHeight;
      }).catch(function(){});
    }
    pullNexus();
    setInterval(pullNexus, 8000);

    function renderNexusImg(doc){
      var d = doc.data() || {};
      if (!d.image) return;
      var div = document.createElement('div');
      div.className = 'row';
      div.setAttribute('data-id', doc.id);
      div.style.cssText = 'margin-bottom:12px;';
      var name = document.createElement('div');
      name.className = 'who';
      name.textContent = d.name || 'anon';
      name.style.cssText = 'font-size:11px;opacity:.6;margin-bottom:4px;';
      var img = document.createElement('img');
      img.src = d.image;
      img.style.cssText = 'max-width:100%;border-radius:12px;display:block;';
      img.loading = 'lazy';
      div.appendChild(name);
      div.appendChild(img);
      nexusChat.appendChild(div);
    }

    function uploadImage(file){
      if (!file || !canPost) return;
      var reader = new FileReader();
      reader.onload = function(e){
        var dataUrl = e.target.result;
        // Compress: max 800px wide, JPEG 0.7
        var img = new Image();
        img.onload = function(){
          var canvas = document.createElement('canvas');
          var scale = Math.min(1, 800 / img.width);
          canvas.width = img.width * scale;
          canvas.height = img.height * scale;
          canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
          var compressed = canvas.toDataURL('image/jpeg', 0.7);
          db.collection("highway_dm").add({
            name: myName,
            image: compressed,
            ts: new Date().toISOString(),
            tsNum: Date.now(),
          }).catch(function(e){ console.error('Nexus image failed:', e.message); });
        };
        img.src = dataUrl;
      };
      reader.readAsDataURL(file);
    }

    if (nexusImgBtn) nexusImgBtn.addEventListener('click', function(){ nexusImg.click(); });
    if (nexusImg) nexusImg.addEventListener('change', function(){ 
      if (nexusImg.files[0]) uploadImage(nexusImg.files[0]);
      nexusImg.value = '';
    });
  }
})();

// ============ iOS PREMIUM: Visual Viewport + Haptics ============
(function(){
  // Keyboard-aware viewport
  if (window.visualViewport) {
    function updateViewport(){
      document.documentElement.style.setProperty('--viewport-height', window.visualViewport.height + 'px');
    }
    window.visualViewport.addEventListener('resize', updateViewport);
    updateViewport();
  }
  // Haptic feedback
  window.hapticClick = function(){
    try { if ('vibrate' in navigator) navigator.vibrate(15); } catch(e){}
  };
  // Attach to send button and tabs
  document.addEventListener('DOMContentLoaded', function(){
    var send = document.getElementById('send');
    if (send) send.addEventListener('click', window.hapticClick);
    document.querySelectorAll('.tab').forEach(function(t){
      t.addEventListener('click', window.hapticClick);
    });
  });
})();

// ============ FLEX-LOCK: auto-scroll + rubber-band guard ============
(function(){
  function scrollChatToBottom(){
    var chat = document.getElementById('chat');
    if (chat) chat.scrollTop = chat.scrollHeight;
  }
  // Snap to bottom when keyboard opens
  var msgInput = document.getElementById('msg');
  if (msgInput) {
    msgInput.addEventListener('focus', function(){
      setTimeout(scrollChatToBottom, 150);
    });
  }
  // Kill global rubber-banding, preserve chat scroll
  document.body.addEventListener('touchmove', function(e){
    if (!e.target.closest('#chat')) {
      e.preventDefault();
    }
  }, { passive:false });
  // Expose for new message arrivals
  window.scrollChatToBottom = scrollChatToBottom;
})();

// ============ Streaming render buffer (rAF) ============
// Prevents iOS frame drops when models dump tokens fast.
// Queue chunks, render synced to display refresh rate.
(function(){
  var tokenQueue = [];
  var isRendering = false;
  function renderLoop(){
    if (tokenQueue.length > 0) {
      var chunk = tokenQueue.shift();
      var bubble = document.querySelector('.bubble.streaming:last-child');
      if (bubble) {
        bubble.textContent += chunk;
        var chat = document.getElementById('chat');
        if (chat) chat.scrollTop = chat.scrollHeight;
      }
      requestAnimationFrame(renderLoop);
    } else {
      isRendering = false;
    }
  }
  window.streamToken = function(textChunk){
    tokenQueue.push(textChunk);
    if (!isRendering) {
      isRendering = true;
      requestAnimationFrame(renderLoop);
    }
  };
})();
