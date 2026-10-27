'use client';
import {useEffect,useRef,useState} from 'react';
import {X,UserRound} from 'lucide-react';

export default function ProfilePhoto({id,name,size=42,role,phone}:{id:string;name:string;size?:number;role?:string;phone?:string}){
 const [open,setOpen]=useState(false),[failed,setFailed]=useState(false),dialog=useRef<HTMLDialogElement>(null);
 useEffect(()=>{setFailed(false)},[id]);
 useEffect(()=>{if(open)dialog.current?.showModal();else dialog.current?.close()},[open]);
 return <><button type="button" className="photo-trigger" style={{width:size,height:size}} onClick={()=>{setFailed(false);setOpen(true)}} aria-label={'View '+name+(role?'’s profile':'’s profile picture')}>{failed?<UserRound size={22}/>:<img src={'/api/photo/'+encodeURIComponent(id)} alt={name} onError={()=>setFailed(true)}/>}</button><dialog ref={dialog} className="photo-dialog" onCancel={()=>setOpen(false)} onClose={()=>setOpen(false)} onClick={e=>{if(e.target===e.currentTarget)setOpen(false)}}><button type="button" className="close" aria-label="Close profile picture" onClick={()=>setOpen(false)}><X/></button><h2>{name}</h2>{role&&<p>{role}</p>}{phone&&<p><a href={'tel:'+phone}>{phone}</a></p>}{failed?<p>This profile picture could not be loaded. Close it and try again after checking your connection.</p>:<img className="photo-full" src={'/api/photo/'+encodeURIComponent(id)} alt={name+'’s profile picture'} onError={()=>setFailed(true)}/>}</dialog></>;
}
